package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Streaming, when it does not go to plan.
//
// Agent clients abandon streams constantly — a user hits escape, a tool call supersedes
// the answer, an editor cancels. Three things have to hold when that happens, none of
// them visible in a normal test, and all three cheap to break in a refactor:
//
//   - the upstream has to stop. If it does not, the model keeps generating into a socket
//     nobody is reading and the bill keeps running. This is the expensive one, and it
//     fails silently: everything still works, it just costs more.
//   - no goroutine may be left behind, or an abandoned stream becomes a slow leak.
//   - the request still has to be recorded with what it actually consumed, because the
//     tokens produced before the client left were paid for.
//
// The first assertion is deliberately about the outcome and not the mechanism. Removing
// the client context from the upstream request does not break it — the relay stops
// reading, the body is closed, and the upstream notices anyway. What does break it is
// buffering: draining the upstream into memory before writing to the client makes the
// generation run to completion no matter when the client leaves. Injecting that turns
// 15 chunks into 2435 and 2 seconds into 27, and this test fails on it. That is the
// regression worth catching, and it is the kind a reasonable refactor introduces.

func streamBody() []byte {
	raw, _ := json.Marshal(map[string]any{
		"model": "test-model", "stream": true,
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	return raw
}

func TestAbandonedStreamCancelsUpstreamAndIsStillAccounted(t *testing.T) {
	const rounds = 5

	var chunksSent, cancellations, handlersDone atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer handlersDone.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 500; i++ {
			if _, err := fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"chunk%d\"}}]}\n\n", i); err != nil {
				return
			}
			chunksSent.Add(1)
			if flusher != nil {
				flusher.Flush()
			}
			select {
			case <-r.Context().Done():
				// The gateway told us the client is gone. This is the assertion that
				// matters: without it the loop would run all 500 chunks.
				cancellations.Add(1)
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	settle := func() int {
		for i := 0; i < 30; i++ {
			runtime.GC()
			time.Sleep(30 * time.Millisecond)
		}
		return runtime.NumGoroutine()
	}
	before := settle()

	for round := 0; round < rounds; round++ {
		ctx, cancel := context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			proxy.URL+"/v1/chat/completions", bytes.NewReader(streamBody()))
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			t.Fatalf("round %d: %v", round, err)
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
			resp.Body.Close()
			cancel()
			t.Fatalf("round %d: stream did not start: %d %s", round, resp.StatusCode, body)
		}
		reader := bufio.NewReader(resp.Body)
		for read := 0; read < 3; {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			if len(line) > 1 {
				read++
			}
		}
		cancel() // the client walks away mid-stream
		resp.Body.Close()
	}

	deadline := time.Now().Add(5 * time.Second)
	for cancellations.Load() < rounds && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	if got := cancellations.Load(); got != rounds {
		t.Errorf("the upstream saw %d of %d cancellations. When a client abandons a stream the "+
			"gateway must close the upstream request; otherwise the model keeps generating into "+
			"a socket nobody reads and the tokens are still billed.", got, rounds)
	}
	if got := handlersDone.Load(); got != rounds {
		t.Errorf("%d of %d upstream handlers finished; the rest are still generating", got, rounds)
	}
	// Anti-vacuity: if the upstream had never produced anything, everything above would
	// pass without the cancellation path being exercised at all.
	if sent := chunksSent.Load(); sent < rounds*3 {
		t.Fatalf("upstream only sent %d chunks across %d streams; the streams never really started",
			sent, rounds)
	}
	// And it must have been cut short. 500 chunks per stream were on offer.
	if sent := chunksSent.Load(); sent > int64(rounds)*100 {
		t.Errorf("upstream sent %d chunks; the streams ran on well past the client leaving", sent)
	}

	after := settle()
	if after > before+2 {
		t.Errorf("goroutines went from %d to %d across %d abandoned streams; "+
			"an abandoned stream is leaking", before, after, rounds)
	}

	// The tokens produced before the client left were paid for, so they have to be
	// recorded. A row with zero tokens would mean the spend is invisible.
	var rows []store.RecentRequest
	deadline = time.Now().Add(5 * time.Second)
	for {
		rows, err = db.RecentRequests(context.Background(), store.RequestFilter{Limit: 50})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) >= rounds || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(rows) != rounds {
		t.Fatalf("%d abandoned streams produced %d request_logs rows; the spend is unaccounted for",
			rounds, len(rows))
	}
	for _, row := range rows {
		if row.TotalTokens <= 0 {
			t.Errorf("an abandoned stream was recorded with %d tokens, so what the upstream "+
				"generated before the client left is invisible in usage and cost", row.TotalTokens)
		}
		if row.EstimatedCost <= 0 {
			t.Errorf("an abandoned stream was recorded at %v cost despite %d tokens",
				row.EstimatedCost, row.TotalTokens)
		}
	}
}

// A stalled upstream must not become a stalled client. Both budgets are checked: the
// overall request timeout, and the response-header timeout that exists to give up sooner
// when the upstream accepts the connection and then says nothing at all.
func TestStalledUpstreamFailsWithinItsBudget(t *testing.T) {
	hold := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select { // headers are never written
		case <-hold:
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
	}))
	defer upstream.Close()
	defer close(hold)

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	for _, tc := range []struct {
		name           string
		timeout        time.Duration
		responseHeader time.Duration
		wantWithin     time.Duration
	}{
		{"overall timeout", 2 * time.Second, 0, 4 * time.Second},
		// The header timeout is well inside the overall one, so a pass here means it was
		// the header timeout that fired and not the other.
		{"response header timeout", 20 * time.Second, time.Second, 3 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig(upstream.URL, "s")
			cfg.Upstream.Timeout = tc.timeout
			cfg.Upstream.ResponseHeaderTimeout = tc.responseHeader
			server, err := NewServer(cfg, db, logger, nil)
			if err != nil {
				t.Fatal(err)
			}
			proxy := httptest.NewServer(server.Routes())
			defer proxy.Close()

			body, _ := json.Marshal(map[string]any{"model": "test-model",
				"messages": []map[string]string{{"role": "user", "content": "hi"}}})
			req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")

			start := time.Now()
			resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
			elapsed := time.Since(start)
			if err != nil {
				t.Fatalf("the client gave up before the gateway answered (%v): %v", elapsed, err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()

			if elapsed > tc.wantWithin {
				t.Errorf("gateway took %v to give up on a silent upstream, want under %v", elapsed, tc.wantWithin)
			}
			if resp.StatusCode != http.StatusGatewayTimeout {
				t.Errorf("a stalled upstream returned %d, want 504", resp.StatusCode)
			}
		})
	}
}
