package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// balanceFixture is a gateway with a pool of three providers serving one model and
// round-robin balancing on, which is the shape balanceProvider exists for.
//
// The balancer's own picking is unit-tested against b.pick. What was not tested is the
// function around it: whether balancing applies at all, whether an explicit choice
// outranks it, and which candidates it is allowed to consider. Those decide where a
// request actually goes.
func balanceFixture(t *testing.T) *Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	ctx := context.Background()
	for _, name := range []string{"gpu-a", "gpu-b", "gpu-c"} {
		if err := db.UpsertProvider(ctx, store.ProviderConfig{
			Name: name, BaseURL: "http://" + name + ".invalid", EncryptedAPIKey: "x",
			TimeoutMS: 1000, Enabled: true, ModelPatterns: "core-*", Priority: 100,
			CreatedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	upstream := httptest.NewServer(nil)
	t.Cleanup(upstream.Close)

	cfg := testConfig(upstream.URL, "s")
	cfg.Upstream.LoadBalance = "round_robin"
	cfg.Upstream.StickySessions = true
	// Breakers are on by default in production, so that is the configuration the
	// balancer has to work under.
	cfg.Upstream.BreakerEnabled = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func balanceReq(t *testing.T, target string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://gateway.invalid"+target, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// Balancing has to happen at all under the production configuration. The breaker filter
// sits inside the candidate loop, and getting its condition wrong empties the pool: every
// candidate is skipped, there is nothing to balance, and every request silently falls back
// to the first matching provider instead.
func TestBalancingHappensWithBreakersEnabledAndNoneOpen(t *testing.T) {
	s := balanceFixture(t)
	ctx := context.Background()

	decision, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"), "core-h200", "sess-1", nil)
	if !ok {
		t.Fatal("no provider was balanced to with breakers enabled and none open; the pool was emptied")
	}
	if decision.Provider == "" {
		t.Fatalf("balanced to an empty provider: %+v", decision)
	}
}

// An explicit choice outranks the pool, and it can be made two ways. Requiring both is the
// same as honouring neither: whichever form an operator used stops working, silently, and
// the request goes wherever the pool sends it.
func TestAnExplicitProviderChoiceBypassesTheBalancer(t *testing.T) {
	s := balanceFixture(t)
	ctx := context.Background()

	byHeader := balanceReq(t, "/v1/chat/completions")
	byHeader.Header.Set("X-Proxy-Provider", "gpu-c")
	if _, ok := s.balanceProvider(ctx, byHeader, "core-h200", "sess-1", nil); ok {
		t.Error("a request pinning a provider by header was balanced anyway")
	}

	byQuery := balanceReq(t, "/v1/chat/completions?provider=gpu-c")
	if _, ok := s.balanceProvider(ctx, byQuery, "core-h200", "sess-1", nil); ok {
		t.Error("a request pinning a provider by query parameter was balanced anyway")
	}

	// And with neither, balancing still applies — or the two checks above would pass for
	// a function that never balances anything.
	if _, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"), "core-h200", "sess-1", nil); !ok {
		t.Error("a request pinning nothing was not balanced")
	}
}

// A provider the breaker has taken out must not be handed traffic, and the ones still
// standing must still be.
func TestBalancingSkipsProvidersTheBreakerHasOpened(t *testing.T) {
	s := balanceFixture(t)
	ctx := context.Background()
	_, threshold, _ := s.breakerConfig()

	for i := 0; i < threshold+1; i++ {
		s.breakers.recordFailure("gpu-a", "5xx", threshold, time.Now())
	}

	seen := map[string]bool{}
	for i := 0; i < 12; i++ {
		decision, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"),
			"core-h200", "sess-"+itoaProxy(i), nil)
		if !ok {
			t.Fatalf("session %d was not balanced; the remaining providers should still serve it", i)
		}
		seen[decision.Provider] = true
	}
	if seen["gpu-a"] {
		t.Error("traffic went to a provider whose breaker is open")
	}
	if len(seen) < 2 {
		t.Errorf("only %v served twelve sessions; opening one breaker emptied more than it should", seen)
	}
}

// A provider the caller is not allowed to use is not a candidate, whatever the pool says.
func TestBalancingHonoursPerKeyProviderRules(t *testing.T) {
	s := balanceFixture(t)
	ctx := context.Background()
	authCtx := &store.AuthContext{APIKeyID: "k1", DeniedProviders: []string{"gpu-a", "gpu-b"}}

	for i := 0; i < 8; i++ {
		decision, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"),
			"core-h200", "sess-"+itoaProxy(i), authCtx)
		if !ok {
			t.Fatalf("session %d was not balanced although one provider is allowed", i)
		}
		if decision.Provider != "gpu-c" {
			t.Fatalf("balanced to %q, which this key is denied", decision.Provider)
		}
	}
}

// Sticky sessions are a switch, and switching them off has to stop the binding being
// recorded. Otherwise a session is pinned to whichever provider it first reached, and the
// setting that is supposed to spread it looks like it does nothing.
func TestStickyOffLetsASessionRotate(t *testing.T) {
	b := newProviderBalancer()
	pool := []string{"gpu-a", "gpu-b", "gpu-c"}
	now := time.Unix(1_700_000_000, 0).UTC()

	seen := map[string]bool{}
	for turn := 0; turn < 6; turn++ {
		decision, ok := b.pick("core-h200", "one-session", pool, balanceRoundRobin, false, time.Hour, now)
		if !ok {
			t.Fatalf("turn %d was not picked for", turn)
		}
		if decision.Reason == "sticky_session" {
			t.Fatalf("turn %d was served from a sticky binding although sticky is off", turn)
		}
		seen[decision.Provider] = true
	}
	if len(seen) < 2 {
		t.Fatalf("six turns of one session all went to %v with sticky off; the binding is still "+
			"being recorded", seen)
	}

	// And with sticky on, the same session does stay put — or the assertions above would
	// hold for a balancer that never binds anything.
	sticky := newProviderBalancer()
	first, _ := sticky.pick("core-h200", "one-session", pool, balanceRoundRobin, true, time.Hour, now)
	again, _ := sticky.pick("core-h200", "one-session", pool, balanceRoundRobin, true, time.Hour, now)
	if again.Provider != first.Provider || again.Reason != "sticky_session" {
		t.Fatalf("with sticky on the session moved from %q to %q (%s)", first.Provider, again.Provider, again.Reason)
	}
}

// One matching provider is not a pool. Balancing it would change the recorded route reason
// for every single-provider model from a first match to a round robin of one, which is a
// different story about how the request was routed for no different outcome.
func TestASingleCandidateIsNotBalanced(t *testing.T) {
	s := balanceFixture(t)
	ctx := context.Background()

	// A model only one provider serves.
	if err := s.db.UpsertProvider(ctx, store.ProviderConfig{
		Name: "solo", BaseURL: "http://solo.invalid", EncryptedAPIKey: "x", TimeoutMS: 1000,
		Enabled: true, ModelPatterns: "lonely-*", Priority: 100, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	if _, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"), "lonely-model", "sess-1", nil); ok {
		t.Error("a model served by one provider was routed through the balancer")
	}
	// The pooled model is still balanced, so this is not just "balancing never happens".
	if _, ok := s.balanceProvider(ctx, balanceReq(t, "/v1/chat/completions"), "core-h200", "sess-1", nil); !ok {
		t.Error("the pooled model stopped being balanced")
	}
}

// A body with no messages carries no conversation, so it must not produce an affinity key.
// Returning one would put every such request on the same provider — they would all hash
// the same empty conversation.
func TestABodyWithoutMessagesHasNoConversationAffinity(t *testing.T) {
	for _, body := range []string{
		`{"model":"core-h200","messages":[]}`,
		`{"model":"core-h200"}`,
		`{"model":"core-h200","messages":"not-a-list"}`,
		`not json at all`,
	} {
		if got := conversationAffinity([]byte(body), "key_1"); got != "" {
			t.Errorf("%s produced affinity %q; requests with no conversation would all share a provider",
				body, got)
		}
	}
	// A body that does carry a conversation still produces one.
	if conversationAffinity(chatBodyWith("sys", "hello", 0), "key_1") == "" {
		t.Error("a normal conversation produced no affinity")
	}
}
