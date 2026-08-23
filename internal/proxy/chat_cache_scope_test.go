package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Who a cached chat response may be served to.
//
// The cache key is built from the request body alone, so by default an identical prompt
// from any caller hits the same entry — including one stored by a different team. For a
// deterministic request that is largely the answer the model would have returned anyway,
// which is why it is the default and stays the default. But X-Cache: HIT also tells the
// second caller that somebody already asked that exact question, and for a templated
// prompt ("summarise record 1234") that is a fact about another team's work.
//
// The README describes what goes into the key. It does not say what follows from what
// is missing, and an operator turning on a cost optimisation is unlikely to work it out.
// So the scope is now a setting, the consequence is written next to it, and both
// behaviours are pinned here.

type cacheScopeResult struct {
	status int
	cache  string
	body   string
}

// runCacheScope sends the same deterministic prompt as two callers on different teams and
// returns what each got back.
func runCacheScope(t *testing.T, scope string) (first, second cacheScopeResult, upstreamCalls int64) {
	t.Helper()

	// Each upstream call answers differently, so a cache hit is visible in the body and
	// not just in a header. With a fixed answer, "the second caller got the first
	// caller's response" would be true even on a miss.
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"answer-%d"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}`, n)
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	ctx := context.Background()
	for _, u := range []struct{ id, secret, team string }{
		{"key-alice", "sk-alice", "team-alpha"},
		{"key-mallory", "sk-mallory", "team-beta"},
	} {
		if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
			ID: u.id, Name: u.id, KeyHash: hashProxyKey(u.secret), Owner: u.id, UserID: u.id,
			Team: u.team, Role: "member", Status: "active", CreatedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}

	cfg := testConfig(upstream.URL, "s")
	cfg.Auth.AdminToken = "rw"
	cfg.Cache.ChatEnabled = true
	cfg.Cache.ChatTTL = time.Hour
	cfg.Cache.ChatScope = scope
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	temperature := 0.0
	payload, _ := json.Marshal(map[string]any{
		"model": "test-model", "temperature": temperature,
		"messages": []map[string]string{{"role": "user", "content": "what is the launch date of project falcon?"}},
	})
	call := func(secret string) cacheScopeResult {
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+secret)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 800))
		resp.Body.Close()
		return cacheScopeResult{status: resp.StatusCode, cache: resp.Header.Get("X-Cache"), body: string(body)}
	}

	first = call("sk-alice")
	second = call("sk-mallory")
	return first, second, calls.Load()
}

// The default is unchanged and deliberately so: narrowing the scope costs hit rate, and
// that trade-off belongs to the operator. This pins it so the default cannot drift
// silently in either direction.
func TestChatCacheIsSharedAcrossTeamsByDefault(t *testing.T) {
	alice, mallory, upstreamCalls := runCacheScope(t, "global")

	if alice.status != http.StatusOK || mallory.status != http.StatusOK {
		t.Fatalf("both callers should be served: alice=%d mallory=%d", alice.status, mallory.status)
	}
	if alice.cache == "HIT" {
		t.Fatal("the first caller hit the cache, so the fixture is not starting empty")
	}
	if mallory.cache != "HIT" {
		t.Errorf("with scope=global the second caller got X-Cache=%q, want HIT — the default "+
			"shares entries between callers and this test exists to notice if that changes",
			mallory.cache)
	}
	if !strings.Contains(mallory.body, "answer-1") {
		t.Errorf("the second caller did not receive the first caller's cached answer: %s", mallory.body)
	}
	if upstreamCalls != 1 {
		t.Errorf("upstream was called %d times; a shared cache should have served the second "+
			"request without it", upstreamCalls)
	}
}

// scope=team is the reason this setting exists: an entry stored by one team must be
// unreachable from another, both as content and as the existence signal in X-Cache.
func TestChatCacheScopeTeamKeepsEntriesInsideTheTeam(t *testing.T) {
	alice, mallory, upstreamCalls := runCacheScope(t, "team")

	if mallory.cache == "HIT" {
		t.Errorf("with scope=team a caller on team-beta hit an entry stored by team-alpha")
	}
	if strings.Contains(mallory.body, "answer-1") {
		t.Errorf("with scope=team the second caller received the first team's answer: %s", mallory.body)
	}
	if !strings.Contains(mallory.body, "answer-2") {
		t.Errorf("the second caller should have been served fresh from upstream, got: %s", mallory.body)
	}
	if upstreamCalls != 2 {
		t.Errorf("upstream was called %d times; with the cache scoped per team both requests "+
			"must reach it", upstreamCalls)
	}
	if alice.cache == "HIT" {
		t.Error("the first caller hit the cache, so the fixture is not starting empty")
	}
}

// An unknown value must not fail requests: a typo in a cache setting is not a reason to
// stop serving traffic, and falling back to the default is what the code does.
func TestUnknownChatCacheScopeFallsBackToGlobal(t *testing.T) {
	if got := chatCacheScopeValue("nonsense", &store.AuthContext{TeamID: "t"}, "k"); got != "" {
		t.Errorf("an unrecognised scope produced %q; it should behave as global (no mixing)", got)
	}
	// A caller with no team must not silently widen to global under scope=team.
	if got := chatCacheScopeValue("team", &store.AuthContext{}, "key-1"); got != "key:key-1" {
		t.Errorf("scope=team with no team on the caller produced %q, want the narrower "+
			"per-key scope rather than a shared entry", got)
	}
}
