package proxy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Concurrency.
//
// The gateway keeps a lot of state shared between in-flight requests: the balancer's
// round-robin cursor and its sticky session map, the breaker's per-provider counters,
// the runtime config overlays that admin settings swap under live traffic, and the async
// logger's queue. Twenty goroutines are started by the server itself.
//
// Running the suite under -race said nothing about any of it. The race detector only
// reports races it observes, and until this test there was exactly one test in the
// repository that issued concurrent requests — so a green -race run meant the concurrent
// paths had never been executed concurrently, not that they were safe.
//
// This drives them all at once: many conversations in parallel, a provider failing often
// enough to move the breaker through its states, and an operator changing runtime
// settings in the middle. It asserts what should hold regardless of interleaving, and
// under -race it is also the thing that would surface an unsynchronised access.
//
// Two things were measured rather than assumed. The balancer really is entered
// concurrently — 192 calls with up to 7 in flight at once — and an unsynchronised field
// incremented at the top of handleOpenAI is reported by -race on the first run.
//
// One limit is worth stating, because it bounds what a green run here means. The same
// unsynchronised increment placed deeper in the pipeline was NOT reported, and that is
// not a flaw in this test: the request path crosses the store's own locking on the way
// down, and a mutex between two accesses gives the detector the happens-before edge it
// needs to consider them ordered. Race detection is dynamic and can be masked by
// unrelated synchronisation, so this test failing is strong evidence of a race, while it
// passing is evidence about the paths it reaches, not a proof of thread safety.
func TestConcurrentTrafficWithBreakerAndSettingsChurn(t *testing.T) {
	const (
		conversations  = 24
		turnsPerConv   = 8
		flakyProvider  = 2 // gpu-c returns 500 for a while, to drive breaker transitions
		flakyFailUntil = 20
	)

	var hits [3]atomic.Int64
	var flakyCalls atomic.Int64
	names := []string{"gpu-a", "gpu-b", "gpu-c"}
	servers := make([]*httptest.Server, 3)
	for i := range servers {
		idx := i
		servers[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits[idx].Add(1)
			if idx == flakyProvider && flakyCalls.Add(1) <= flakyFailUntil {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":"upstream is unwell"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
		}))
		defer servers[i].Close()
	}

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 256, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Auth.AdminToken = "rw-secret"
	cfg.Upstream.LoadBalance = "round_robin"
	cfg.Upstream.StickySessions = true
	cfg.Upstream.StickyTTL = time.Hour
	cfg.Upstream.BreakerEnabled = true
	cfg.Upstream.BreakerThreshold = 3
	cfg.Upstream.BreakerCooldown = 200 * time.Millisecond
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for i, n := range names {
		resp := postJSON(t, proxy.URL+"/admin/providers", "rw-secret", map[string]any{
			"name": n, "base_url": servers[i].URL, "api_key": "k",
			"timeout_ms": 5000, "enabled": true, "model_patterns": "core-h200",
		})
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("upsert %s: %d %s", n, resp.StatusCode, b)
		}
		resp.Body.Close()
	}

	stop := make(chan struct{})
	var churn sync.WaitGroup

	// An operator retuning the breaker while traffic runs. This is the case the runtime
	// overlay exists for, and it means requests read the config while it is replaced.
	churn.Add(1)
	go func() {
		defer churn.Done()
		thresholds := []int{2, 5, 3, 8}
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			resp := postJSON(t, proxy.URL+"/admin/settings", "rw-secret", map[string]any{
				"key": "upstream.breaker_threshold", "value": fmt.Sprint(thresholds[i%len(thresholds)]),
			})
			resp.Body.Close()
			time.Sleep(5 * time.Millisecond)
		}
	}()

	// Somebody watching the dashboards while it happens: these read the same breaker and
	// balancer state the request path is mutating.
	churn.Add(1)
	go func() {
		defer churn.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, path := range []string{"/admin/routing/health", "/admin/routing/balancer?model=core-h200"} {
				req, _ := http.NewRequest(http.MethodGet, proxy.URL+path, nil)
				req.Header.Set("Authorization", "Bearer rw-secret")
				if resp, err := http.DefaultClient.Do(req); err == nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()

	type result struct {
		providers map[string]int
		statuses  map[int]int
	}
	results := make([]result, conversations)
	var wg sync.WaitGroup
	for c := 0; c < conversations; c++ {
		wg.Add(1)
		go func(c int) {
			defer wg.Done()
			r := result{providers: map[string]int{}, statuses: map[int]int{}}
			system := "You are a coding agent."
			first := fmt.Sprintf("conversation %d: refactor module %d", c, c)
			for turn := 0; turn < turnsPerConv; turn++ {
				req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions",
					bytes.NewReader(chatBodyWith(system, first, turn)))
				if err != nil {
					t.Errorf("conversation %d turn %d: %v", c, turn, err)
					return
				}
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("User-Agent", "QwenCode/0.2.1 (linux; x64)")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Errorf("conversation %d turn %d: %v", c, turn, err)
					return
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				r.statuses[resp.StatusCode]++
				if p := resp.Header.Get("X-Provider"); p != "" {
					r.providers[p]++
				}
			}
			results[c] = r
		}(c)
	}
	wg.Wait()
	close(stop)
	churn.Wait()

	// Every request must have been answered by somebody. A pool of three where one is
	// failing has two healthy members, so a 5xx reaching the client means failover did
	// not do its job under load.
	total, served := 0, 0
	for c, r := range results {
		for status, n := range r.statuses {
			total += n
			if status == http.StatusOK {
				served += n
			} else {
				t.Errorf("conversation %d saw %d response(s) with status %d", c, n, status)
			}
		}
	}
	if total != conversations*turnsPerConv {
		t.Fatalf("expected %d requests, accounted for %d", conversations*turnsPerConv, total)
	}
	if served != total {
		t.Errorf("%d of %d requests were not served successfully", total-served, total)
	}

	// Stickiness is a per-conversation property and must survive the interleaving: a
	// conversation may move once if its provider was taken out by the breaker, but it
	// must not be sprayed across the pool.
	for c, r := range results {
		if len(r.providers) > 2 {
			t.Errorf("conversation %d was spread across %d providers %v; stickiness did not hold under concurrency",
				c, len(r.providers), r.providers)
		}
	}

	// And the pool was actually used — otherwise the whole run proves nothing about
	// shared state, because there was only ever one path through it.
	used := 0
	for i := range hits {
		if hits[i].Load() > 0 {
			used++
		}
	}
	if used < 2 {
		t.Fatalf("only %d provider(s) received traffic (a=%d b=%d c=%d); the balancer never shared state",
			used, hits[0].Load(), hits[1].Load(), hits[2].Load())
	}
	t.Logf("served %d requests across %d conversations; provider hits a=%d b=%d c=%d",
		total, conversations, hits[0].Load(), hits[1].Load(), hits[2].Load())
}
