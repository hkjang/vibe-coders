package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func chatBodyWith(system, firstUser string, turns int) []byte {
	msgs := []map[string]any{{"role": "system", "content": system}, {"role": "user", "content": firstUser}}
	// Later turns append to the same conversation; the prefix above never changes.
	for i := 0; i < turns; i++ {
		msgs = append(msgs,
			map[string]any{"role": "assistant", "content": "reply " + itoaProxy(i)},
			map[string]any{"role": "user", "content": "follow-up " + itoaProxy(i)})
	}
	b, _ := json.Marshal(map[string]any{"model": "core-h200", "messages": msgs})
	return b
}

// The whole point: qwen code sends no session id to a generic OpenAI-compatible
// endpoint, so identity has to come from the conversation prefix. Same conversation
// (however many turns) → one key; different conversations → different keys, even from
// the same client, key and machine.
func TestConversationAffinityIsStablePerConversation(t *testing.T) {
	convA := chatBodyWith("You are a coding agent.", "refactor auth.go", 0)
	convAlater := chatBodyWith("You are a coding agent.", "refactor auth.go", 5)
	convB := chatBodyWith("You are a coding agent.", "write tests for parser.go", 0)

	keyA := conversationAffinity(convA, "key_1")
	keyAlater := conversationAffinity(convAlater, "key_1")
	keyB := conversationAffinity(convB, "key_1")

	if keyA == "" {
		t.Fatal("no affinity derived from a normal chat body")
	}
	if keyA != keyAlater {
		t.Fatalf("affinity changed as the conversation grew: %q vs %q", keyA, keyAlater)
	}
	if keyA == keyB {
		t.Fatal("two different conversations produced the same affinity key")
	}
	// Different callers must not share a binding just because they opened alike.
	if conversationAffinity(convA, "key_2") == keyA {
		t.Fatal("affinity key is not scoped per api key")
	}
}

func TestResolveSessionAffinityPrefersExplicitIdentity(t *testing.T) {
	body := chatBodyWith("sys", "hello", 0)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("X-Session-ID", "explicit-1")
	if got := resolveSessionAffinity(req, body, "key_1", "inferred-1"); got.Source != affinitySourceHeader {
		t.Fatalf("header identity ignored: %+v", got)
	}
	// qwen code's planned header should be honoured if a client is set up to send it.
	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req2.Header.Set("X-Qwen-Code-Session-Id", "qwen-1")
	if got := resolveSessionAffinity(req2, body, "key_1", ""); got.Source != affinitySourceHeader {
		t.Fatalf("qwen-code session header ignored: %+v", got)
	}

	bare := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	withBody, _ := json.Marshal(map[string]any{"model": "m", "messages": []any{}, "session_id": "body-1"})
	if got := resolveSessionAffinity(bare, withBody, "key_1", ""); got.Source != affinitySourceBody {
		t.Fatalf("body session id ignored: %+v", got)
	}

	// No client cooperation at all: fall back to the conversation prefix, NOT the
	// coarse inferred session, which would merge every concurrent conversation.
	if got := resolveSessionAffinity(bare, body, "key_1", "inferred-1"); got.Source != affinitySourceConv {
		t.Fatalf("expected conversation affinity, got %+v", got)
	}
	// An embedding has no conversation but does have content of its own, which is what
	// lets a batch spread across the pool instead of collapsing onto one key.
	embedBody, _ := json.Marshal(map[string]any{"model": "m", "input": "embed me"})
	if got := resolveSessionAffinity(bare, embedBody, "key_1", "inferred-1"); got.Source != affinitySourceContent {
		t.Fatalf("expected content affinity for an embedding, got %+v", got)
	}
	// Only a body offering neither falls through to the coarse inferred session.
	noContent, _ := json.Marshal(map[string]any{"model": "m"})
	if got := resolveSessionAffinity(bare, noContent, "key_1", "inferred-1"); got.Source != affinitySourceInferred {
		t.Fatalf("expected inferred fallback, got %+v", got)
	}
}

func TestBalancerRoundRobinsSessionsAndKeepsThemSticky(t *testing.T) {
	b := newProviderBalancer()
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()

	// Three distinct sessions land on three distinct providers.
	first := map[string]string{}
	for _, sess := range []string{"s1", "s2", "s3"} {
		d, ok := b.pick("core-h200", sess, pool, balanceRoundRobin, true, ttl, now)
		if !ok {
			t.Fatalf("no pick for %s", sess)
		}
		if d.Reason != "round_robin" {
			t.Fatalf("%s: first pick should rotate, got %q", sess, d.Reason)
		}
		first[sess] = d.Provider
	}
	seen := map[string]bool{}
	for _, p := range first {
		seen[p] = true
	}
	if len(seen) != 3 {
		t.Fatalf("three sessions did not spread across three providers: %+v", first)
	}

	// Every later turn of each session stays on its provider.
	for turn := 0; turn < 4; turn++ {
		for sess, want := range first {
			d, ok := b.pick("core-h200", sess, pool, balanceRoundRobin, true, ttl, now.Add(time.Duration(turn)*time.Minute))
			if !ok || d.Provider != want {
				t.Fatalf("%s turn %d moved to %q, want %q", sess, turn, d.Provider, want)
			}
			if d.Reason != "sticky_session" {
				t.Fatalf("%s turn %d reason=%q, want sticky_session", sess, turn, d.Reason)
			}
		}
	}
}

// A binding must not survive its provider becoming unusable (breaker open, disabled).
func TestBalancerRebindsWhenBoundProviderLeavesThePool(t *testing.T) {
	b := newProviderBalancer()
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()

	d, _ := b.pick("core-h200", "s1", []string{"gpu-a", "gpu-b"}, balanceRoundRobin, true, ttl, now)
	bound := d.Provider

	remaining := []string{}
	for _, p := range []string{"gpu-a", "gpu-b"} {
		if p != bound {
			remaining = append(remaining, p)
		}
	}
	next, ok := b.pick("core-h200", "s1", remaining, balanceRoundRobin, true, ttl, now.Add(time.Minute))
	if !ok || next.Provider == bound {
		t.Fatalf("session stayed on a provider that left the pool: %+v", next)
	}
	if next.Reason != "round_robin" {
		t.Fatalf("expected a fresh rotation after the binding was dropped, got %q", next.Reason)
	}
}

// Stickiness is per session AND model: one session using two models may sit on a
// different provider for each, because the candidate pools differ.
func TestBalancerStickyKeyIsPerModel(t *testing.T) {
	b := newProviderBalancer()
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()
	pool := []string{"gpu-a", "gpu-b"}

	a, _ := b.pick("core-h200", "s1", pool, balanceRoundRobin, true, ttl, now)
	c, _ := b.pick("other-model", "s1", pool, balanceRoundRobin, true, ttl, now)
	if a.Reason != "round_robin" || c.Reason != "round_robin" {
		t.Fatalf("per-model cursors should each start fresh: %+v %+v", a, c)
	}
	again, _ := b.pick("core-h200", "s1", pool, balanceRoundRobin, true, ttl, now)
	if again.Provider != a.Provider {
		t.Fatalf("per-model stickiness broken: %q vs %q", again.Provider, a.Provider)
	}
}

func TestBalancerRebindFollowsFailoverAndReleaseDrains(t *testing.T) {
	b := newProviderBalancer()
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()
	pool := []string{"gpu-a", "gpu-b"}

	d, _ := b.pick("core-h200", "s1", pool, balanceRoundRobin, true, ttl, now)
	other := "gpu-a"
	if d.Provider == "gpu-a" {
		other = "gpu-b"
	}
	// Failover served the turn elsewhere; the binding must follow.
	b.rebind("core-h200", "s1", other, now)
	next, _ := b.pick("core-h200", "s1", pool, balanceRoundRobin, true, ttl, now.Add(time.Minute))
	if next.Provider != other || next.Reason != "sticky_session" {
		t.Fatalf("binding did not follow the failover: %+v (want %s)", next, other)
	}

	if released := b.release(other); released != 1 {
		t.Fatalf("release removed %d bindings, want 1", released)
	}
	after, _ := b.pick("core-h200", "s1", pool, balanceRoundRobin, true, ttl, now.Add(2*time.Minute))
	if after.Reason != "round_robin" {
		t.Fatalf("drained session should be re-rotated, got %q", after.Reason)
	}
}

func shares(counts ...int64) []store.ProviderModelShare {
	out := make([]store.ProviderModelShare, 0, len(counts))
	for i, n := range counts {
		out = append(out, store.ProviderModelShare{Provider: "p" + itoaProxy(i), Requests: n})
	}
	return out
}

func TestBalanceIndexScoresEvenness(t *testing.T) {
	if even := balanceIndex(shares(30, 30, 30)); even != 1 {
		t.Fatalf("perfectly even split scored %v, want 1", even)
	}
	if skewed := balanceIndex(shares(90, 0, 0)); skewed != 0 {
		t.Fatalf("all-to-one scored %v, want 0", skewed)
	}
	if single := balanceIndex(shares(10)); single != 1 {
		t.Fatalf("a single provider cannot be unbalanced, scored %v", single)
	}
	if half := balanceIndex(shares(20, 10)); half != 0.5 {
		t.Fatalf("2:1 split scored %v, want 0.5", half)
	}
}

// End-to-end with the real qwen code request shape: no session header, no body
// session id, only User-Agent: QwenCode/... — the exact thing its default
// OpenAI-compatible provider sends. Concurrent conversations must spread across the
// pool, and each conversation's turns must stay put.
func TestQwenCodeShapedSessionsRoundRobinAndStick(t *testing.T) {
	var hits [3]atomic.Int32
	names := []string{"gpu-a", "gpu-b", "gpu-c"}
	servers := make([]*httptest.Server, 3)
	for i := range servers {
		idx := i
		servers[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits[idx].Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
		}))
		defer servers[i].Close()
	}

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Upstream.LoadBalance = "round_robin"
	cfg.Upstream.StickySessions = true
	cfg.Upstream.StickyTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for i, n := range names {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": n, "base_url": servers[i].URL, "api_key": "k",
			"timeout_ms": 5000, "enabled": true, "model_patterns": "core-h200",
		})
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("upsert %s: %d %s", n, resp.StatusCode, b)
		}
		resp.Body.Close()
	}

	// One qwen code turn: same UA and key for every conversation, nothing else.
	turn := func(system, firstUser string, turnIdx int) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions",
			bytes.NewReader(chatBodyWith(system, firstUser, turnIdx)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "QwenCode/0.2.1 (linux; x64)")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		return resp
	}

	conversations := []struct{ system, first string }{
		{"You are a coding agent.", "refactor auth.go"},
		{"You are a coding agent.", "write tests for parser.go"},
		{"You are a coding agent.", "explain the build pipeline"},
	}

	bound := make([]string, len(conversations))
	for i, c := range conversations {
		resp := turn(c.system, c.first, 0)
		bound[i] = resp.Header.Get("X-Provider")
		if got := resp.Header.Get("X-Route-Reason"); got != "round_robin" {
			t.Fatalf("conversation %d: X-Route-Reason=%q, want round_robin", i, got)
		}
		if got := resp.Header.Get("X-Session-Affinity"); got != affinitySourceConv {
			t.Fatalf("conversation %d: affinity source=%q, want %s", i, got, affinitySourceConv)
		}
		resp.Body.Close()
	}
	spread := map[string]bool{}
	for _, p := range bound {
		spread[p] = true
	}
	if len(spread) != 3 {
		t.Fatalf("three qwen code conversations did not spread across the pool: %v", bound)
	}

	// Five more turns each: every turn must stay on the conversation's provider.
	for turnIdx := 1; turnIdx <= 5; turnIdx++ {
		for i, c := range conversations {
			resp := turn(c.system, c.first, turnIdx)
			if got := resp.Header.Get("X-Provider"); got != bound[i] {
				t.Fatalf("conversation %d turn %d moved %s -> %s", i, turnIdx, bound[i], got)
			}
			if got := resp.Header.Get("X-Route-Reason"); got != "sticky_session" {
				t.Fatalf("conversation %d turn %d: X-Route-Reason=%q, want sticky_session", i, turnIdx, got)
			}
			resp.Body.Close()
		}
	}

	// 18 requests, 6 per conversation, one provider per conversation.
	for i, n := range names {
		if hits[i].Load() != 6 {
			t.Fatalf("%s served %d requests, want 6 (a=%d b=%d c=%d)",
				n, hits[i].Load(), hits[0].Load(), hits[1].Load(), hits[2].Load())
		}
	}

	// The verification endpoint must agree that the split was even.
	//
	// Poll until every request has been persisted. The endpoint reads request_logs, which
	// the async logger writes off the request path, so the last few writes can still be in
	// flight when the turns above return. Against SQLite they always landed in time and
	// this read looked synchronous; against PostgreSQL the final write reliably lost the
	// race and the endpoint reported 17 of 18 requests — the rows were correct a moment
	// later. Waiting for the count is what the test meant to assert all along.
	var resp *http.Response
	deadline := time.Now().Add(10 * time.Second)
	for {
		r, err := http.Get(proxy.URL + "/admin/routing/balancer?model=core-h200&window=1h")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		var counted struct {
			Actual []struct {
				Requests int64 `json:"requests"`
			} `json:"actual"`
		}
		if err := json.Unmarshal(body, &counted); err != nil {
			t.Fatal(err)
		}
		total := int64(0)
		for _, a := range counted.Actual {
			total += a.Requests
		}
		if total >= 18 || time.Now().After(deadline) {
			if total < 18 {
				t.Fatalf("only %d of 18 requests were persisted within the deadline; the audit log is losing writes", total)
			}
			resp = &http.Response{Body: io.NopCloser(bytes.NewReader(body))}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer resp.Body.Close()
	var out struct {
		Mode           string  `json:"mode"`
		StickySessions bool    `json:"sticky_sessions"`
		ActiveSessions int     `json:"active_sessions"`
		BalanceIndex   float64 `json:"balance_index"`
		Actual         []struct {
			Provider string `json:"provider"`
			Requests int64  `json:"requests"`
		} `json:"actual"`
		Pools []struct {
			Pattern  string `json:"pattern"`
			Size     int    `json:"size"`
			Balanced bool   `json:"balanced"`
		} `json:"pools"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Mode != "round_robin" || !out.StickySessions {
		t.Fatalf("unexpected balancer config: %+v", out)
	}
	if out.ActiveSessions != 3 {
		t.Fatalf("active sticky sessions=%d, want 3", out.ActiveSessions)
	}
	if out.BalanceIndex != 1 {
		t.Fatalf("balance_index=%v, want 1 for an even split (%+v)", out.BalanceIndex, out.Actual)
	}
	if len(out.Actual) != 3 {
		t.Fatalf("expected all three providers in the actual distribution, got %+v", out.Actual)
	}
	for _, sh := range out.Actual {
		if sh.Requests != 6 {
			t.Fatalf("provider %s logged %d requests, want 6", sh.Provider, sh.Requests)
		}
	}
	foundPool := false
	for _, p := range out.Pools {
		if p.Pattern == "core-h200" && p.Size == 3 && p.Balanced {
			foundPool = true
		}
	}
	if !foundPool {
		t.Fatalf("core-h200 pool not reported as balanced: %+v", out.Pools)
	}
}

// The multi-instance contract: independent gateway processes, sharing no state, must
// route the same conversation to the same provider. round_robin cannot do this — its
// cursor is per-process — so session_hash derives the answer from the session key.
func TestSessionHashAgreesAcrossIndependentInstances(t *testing.T) {
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()

	// Three separate processes, each with its own empty balancer.
	instances := []*providerBalancer{newProviderBalancer(), newProviderBalancer(), newProviderBalancer()}

	for i := 0; i < 40; i++ {
		sess := "conv-" + itoaProxy(i)
		want := ""
		for n, inst := range instances {
			d, ok := inst.pick("core-h200", sess, pool, balanceSessionHash, true, ttl, now)
			if !ok {
				t.Fatalf("%s: instance %d made no pick", sess, n)
			}
			if d.Reason != "sticky_hash" {
				t.Fatalf("%s: instance %d reason=%q, want sticky_hash", sess, n, d.Reason)
			}
			if n == 0 {
				want = d.Provider
				continue
			}
			if d.Provider != want {
				t.Fatalf("%s: instance %d chose %q, instance 0 chose %q — stickiness broken across instances",
					sess, n, d.Provider, want)
			}
		}
	}

	// And round_robin demonstrably cannot make that guarantee: two fresh processes
	// both start their cursor at zero, so the SECOND distinct session diverges.
	a, b := newProviderBalancer(), newProviderBalancer()
	_, _ = a.pick("core-h200", "x1", pool, balanceRoundRobin, true, ttl, now) // only A sees x1
	da, _ := a.pick("core-h200", "x2", pool, balanceRoundRobin, true, ttl, now)
	db, _ := b.pick("core-h200", "x2", pool, balanceRoundRobin, true, ttl, now)
	if da.Provider == db.Provider {
		t.Skip("cursor happened to align; the guarantee still does not hold by construction")
	}
}

// Hash assignment has to actually spread, not just be deterministic.
func TestSessionHashSpreadsSessionsAcrossPool(t *testing.T) {
	b := newProviderBalancer()
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	now := time.Unix(1_700_000_000, 0).UTC()

	counts := map[string]int{}
	const sessions = 300
	for i := 0; i < sessions; i++ {
		d, _ := b.pick("core-h200", "conv-"+itoaProxy(i), pool, balanceSessionHash, true, time.Hour, now)
		counts[d.Provider]++
	}
	if len(counts) != 3 {
		t.Fatalf("hash assignment did not use the whole pool: %+v", counts)
	}
	// Uniform hashing over 300 sessions should land each provider well inside ±40%
	// of the 100 average; this is a sanity band, not a statistics test.
	for name, n := range counts {
		if n < 60 || n > 140 {
			t.Fatalf("provider %s took %d/%d sessions, outside the expected band: %+v", name, n, sessions, counts)
		}
	}
}

// Rendezvous hashing is chosen over modulo precisely for this: losing one provider
// must move only the sessions that were on it, not reshuffle the whole population.
func TestSessionHashMinimisesDisruptionWhenPoolShrinks(t *testing.T) {
	full := []string{"gpu-a", "gpu-b", "gpu-c"}
	const sessions = 300

	before := make([]string, sessions)
	for i := 0; i < sessions; i++ {
		before[i] = rendezvousPick(stickyKey("conv-"+itoaProxy(i), "core-h200"), full)
	}
	shrunk := []string{"gpu-a", "gpu-b"} // gpu-c drained or breaker-open

	moved, ownedByGone := 0, 0
	for i := 0; i < sessions; i++ {
		after := rendezvousPick(stickyKey("conv-"+itoaProxy(i), "core-h200"), shrunk)
		if before[i] == "gpu-c" {
			ownedByGone++
			continue // these must move; that is the point
		}
		if after != before[i] {
			moved++
		}
	}
	if ownedByGone == 0 {
		t.Fatal("test is vacuous: no session was on the removed provider")
	}
	if moved != 0 {
		t.Fatalf("%d sessions not on gpu-c were needlessly remapped (modulo-hash behaviour)", moved)
	}
}

// A local override (set after a failover) must win over the hash on that instance,
// and must be dropped once its provider is no longer usable.
func TestSessionHashRespectsLocalFailoverOverride(t *testing.T) {
	b := newProviderBalancer()
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	ttl := time.Hour
	now := time.Unix(1_700_000_000, 0).UTC()

	base, _ := b.pick("core-h200", "s1", pool, balanceSessionHash, true, ttl, now)
	other := "gpu-a"
	if base.Provider == "gpu-a" {
		other = "gpu-b"
	}
	b.rebind("core-h200", "s1", other, now)

	overridden, _ := b.pick("core-h200", "s1", pool, balanceSessionHash, true, ttl, now.Add(time.Minute))
	if overridden.Provider != other || overridden.Reason != "sticky_session" {
		t.Fatalf("failover override ignored: %+v (want %s)", overridden, other)
	}

	// Once the override target drops out of the pool, fall back to the deterministic
	// choice rather than pinning the session to something that cannot serve.
	remaining := []string{}
	for _, p := range pool {
		if p != other {
			remaining = append(remaining, p)
		}
	}
	recovered, _ := b.pick("core-h200", "s1", remaining, balanceSessionHash, true, ttl, now.Add(2*time.Minute))
	if recovered.Reason != "sticky_hash" {
		t.Fatalf("expected the deterministic choice after the override became unusable, got %+v", recovered)
	}
	if recovered.Provider == other {
		t.Fatalf("still routing to the departed provider %q", other)
	}
}

// End-to-end in the recommended multi-instance configuration: two independent
// gateway processes over the same provider pool, qwen-code-shaped requests with no
// session identifier, turns interleaved across BOTH instances. Each conversation must
// stay on one provider regardless of which gateway handled the turn.
func TestSessionHashStickyAcrossTwoGatewayInstances(t *testing.T) {
	var hits [3]atomic.Int32
	names := []string{"gpu-a", "gpu-b", "gpu-c"}
	upstreams := make([]*httptest.Server, 3)
	for i := range upstreams {
		idx := i
		upstreams[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits[idx].Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
		}))
		defer upstreams[i].Close()
	}

	// Two gateways, each with its own Server (own balancer, own breakers) — the only
	// thing they share is the provider configuration, exactly like a real deployment
	// behind a load balancer.
	newGateway := func() *httptest.Server {
		t.Helper()
		db := openTestStore(t)
		t.Cleanup(func() { db.Close() })
		logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
		logger.Start()
		t.Cleanup(func() { logger.Stop(context.Background()) })

		cfg := testConfig("http://unused.invalid", "s")
		cfg.Upstream.LoadBalance = "session_hash"
		cfg.Upstream.StickySessions = true
		cfg.Upstream.StickyTTL = time.Hour
		srv, err := NewServer(cfg, db, logger, nil)
		if err != nil {
			t.Fatal(err)
		}
		gw := httptest.NewServer(srv.Routes())
		t.Cleanup(gw.Close)
		for i, n := range names {
			resp := postJSON(t, gw.URL+"/admin/providers", "", map[string]any{
				"name": n, "base_url": upstreams[i].URL, "api_key": "k",
				"timeout_ms": 5000, "enabled": true, "model_patterns": "core-h200",
			})
			if resp.StatusCode != http.StatusOK {
				b, _ := io.ReadAll(resp.Body)
				t.Fatalf("upsert %s: %d %s", n, resp.StatusCode, b)
			}
			resp.Body.Close()
		}
		return gw
	}
	gwA, gwB := newGateway(), newGateway()

	turn := func(gw *httptest.Server, firstUser string, turnIdx int) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, gw.URL+"/v1/chat/completions",
			bytes.NewReader(chatBodyWith("You are a coding agent.", firstUser, turnIdx)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "QwenCode/0.2.1 (linux; x64)")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		return resp
	}

	const conversations = 12
	bound := make([]string, conversations)
	for i := 0; i < conversations; i++ {
		resp := turn(gwA, "task number "+itoaProxy(i), 0)
		bound[i] = resp.Header.Get("X-Provider")
		if got := resp.Header.Get("X-Route-Reason"); got != "sticky_hash" {
			t.Fatalf("conversation %d: X-Route-Reason=%q, want sticky_hash", i, got)
		}
		if got := resp.Header.Get("X-Session-Affinity"); got != affinitySourceConv {
			t.Fatalf("conversation %d: affinity=%q, want %s", i, got, affinitySourceConv)
		}
		resp.Body.Close()
	}

	// Alternate every subsequent turn between the two gateways.
	for turnIdx := 1; turnIdx <= 4; turnIdx++ {
		for i := 0; i < conversations; i++ {
			gw := gwA
			if (turnIdx+i)%2 == 0 {
				gw = gwB
			}
			resp := turn(gw, "task number "+itoaProxy(i), turnIdx)
			if got := resp.Header.Get("X-Provider"); got != bound[i] {
				t.Fatalf("conversation %d turn %d moved %s -> %s when handled by the other gateway",
					i, turnIdx, bound[i], got)
			}
			resp.Body.Close()
		}
	}

	// The pool must actually be shared out, not just consistently pinned to one node.
	used := map[string]int{}
	for _, p := range bound {
		used[p]++
	}
	if len(used) != 3 {
		t.Fatalf("12 conversations did not reach all three providers: %+v", used)
	}
	total := hits[0].Load() + hits[1].Load() + hits[2].Load()
	if total != conversations*5 {
		t.Fatalf("expected %d upstream calls, got %d", conversations*5, total)
	}
}

// Embeddings carry no conversation, so they used to fall through to the inferred
// session — one key for an entire client. Under session_hash that pins a whole batch
// job to a single provider while the rest of the pool idles, which defeats load
// balancing for the most parallelisable workload the gateway serves.
func TestEmbeddingRequestsSpreadAcrossThePool(t *testing.T) {
	embedBody := func(input string) []byte {
		b, _ := json.Marshal(map[string]any{"model": "core-h200", "input": input})
		return b
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)

	// Identity now comes from the request's own content, not from the client.
	first := resolveSessionAffinity(req, embedBody("chunk one"), "key_1", "inferred-1")
	second := resolveSessionAffinity(req, embedBody("chunk two"), "key_1", "inferred-1")
	if first.Source != affinitySourceContent || second.Source != affinitySourceContent {
		t.Fatalf("embeddings did not use content affinity: %+v %+v", first, second)
	}
	if first.Key == second.Key {
		t.Fatal("two different inputs share one affinity key; a batch job cannot spread")
	}
	// Identical input keeps landing on the same node, where an upstream cache can help.
	if repeat := resolveSessionAffinity(req, embedBody("chunk one"), "key_1", "inferred-1"); repeat.Key != first.Key {
		t.Fatal("the same input produced a different key; cache affinity is lost")
	}
	// Scoped per caller, like conversation affinity.
	if other := resolveSessionAffinity(req, embedBody("chunk one"), "key_2", "inferred-1"); other.Key == first.Key {
		t.Fatal("content affinity is not scoped per api key")
	}

	// The point of all this: a batch actually uses the whole pool.
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	b := newProviderBalancer()
	now := time.Unix(1_700_000_000, 0).UTC()
	counts := map[string]int{}
	for i := 0; i < 120; i++ {
		aff := resolveSessionAffinity(req, embedBody("chunk "+itoaProxy(i)), "key_1", "inferred-1")
		d, ok := b.pick("core-h200", aff.Key, pool, balanceSessionHash, true, time.Hour, now)
		if !ok {
			t.Fatalf("no pick for chunk %d", i)
		}
		counts[d.Provider]++
	}
	if len(counts) != 3 {
		t.Fatalf("a 120-request batch reached only %d of 3 providers: %+v", len(counts), counts)
	}
	for name, n := range counts {
		if n < 20 || n > 70 {
			t.Fatalf("provider %s took %d of 120 embeddings, outside the expected band: %+v", name, n, counts)
		}
	}

	// An explicit session id still wins — a client that declares one knows better.
	withHeader := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	withHeader.Header.Set("X-Session-ID", "explicit-1")
	if got := resolveSessionAffinity(withHeader, embedBody("chunk one"), "key_1", ""); got.Source != affinitySourceHeader {
		t.Fatalf("an explicit session header was ignored for embeddings: %+v", got)
	}
	// A body with neither conversation nor input still falls back to the inferred session.
	bare, _ := json.Marshal(map[string]any{"model": "core-h200"})
	if got := resolveSessionAffinity(req, bare, "key_1", "inferred-1"); got.Source != affinitySourceInferred {
		t.Fatalf("expected the inferred fallback for a body with no content: %+v", got)
	}
}
