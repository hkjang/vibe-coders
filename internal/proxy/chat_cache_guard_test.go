package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// tune adjusts the config before the server is built: the cache settings are read through
// a runtime overlay that is snapshotted at construction, so changing s.cfg afterwards
// changes nothing the request path looks at.
func cacheGuardServer(t *testing.T, tune func(*config.Config)) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	upstream := httptest.NewServer(nil)
	t.Cleanup(upstream.Close)

	cfg := testConfig(upstream.URL, "s")
	cfg.Cache.ChatEnabled = true
	cfg.Cache.ChatTTL = time.Hour
	cfg.Cache.EmbeddingMaxBytes = 1 << 20
	if tune != nil {
		tune(&cfg)
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

func cached(t *testing.T, db *store.SQLStore, key string) bool {
	t.Helper()
	_, found, err := db.GetEmbeddingCache(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// A cached response is served to whoever asks for the same key next, so what goes in
// decides what other callers get back. Only a successful, non-empty, in-budget response
// may be stored.
//
// The one that matters most is the status: caching a 502 turns one upstream failure into
// the answer every later caller receives, for as long as the entry lives, and nothing
// about it looks like an error by then.
func TestOnlySuccessfulResponsesAreCached(t *testing.T) {
	body := []byte(`{"choices":[{"message":{"content":"ok"}}]}`)
	cases := []struct {
		name       string
		key        string
		status     int
		body       []byte
		wantCached bool
	}{
		{"a successful response is cached", "k-ok", http.StatusOK, body, true},
		{"a server error is not cached", "k-500", http.StatusInternalServerError, body, false},
		{"a rate limit is not cached", "k-429", http.StatusTooManyRequests, body, false},
		{"a client error is not cached", "k-400", http.StatusBadRequest, body, false},
		{"an empty body is not cached", "k-empty", http.StatusOK, nil, false},
		{"a body past the size limit is not cached", "k-big", http.StatusOK,
			[]byte(strings.Repeat("A", (1<<20)+1)), false},
		// The limit is a maximum, so a body of exactly that size is within it. Reading it
		// as "too big" would quietly shrink every operator's configured budget by a byte.
		{"a body exactly at the size limit is cached", "k-exact", http.StatusOK,
			[]byte(strings.Repeat("A", 1<<20)), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, db := cacheGuardServer(t, nil)
			s.maybeStoreChatCache(context.Background(), tc.key, tc.status, "application/json", tc.body)
			if got := cached(t, db, tc.key); got != tc.wantCached {
				t.Fatalf("cached=%v want %v", got, tc.wantCached)
			}
		})
	}

	// An empty key stores nothing, whatever the response looks like.
	s, db := cacheGuardServer(t, nil)
	s.maybeStoreChatCache(context.Background(), "", http.StatusOK, "application/json", body)
	if cached(t, db, "") {
		t.Error("a response with no cache key was stored under the empty key")
	}
}

// Turning the chat cache off has to stop it, and the gate that does so also checks the
// method and the path. Requiring all three to be wrong before declining is the same as
// declining nothing: a disabled cache would still serve and store.
func TestTheChatCacheGateDeclinesOnAnyOneReason(t *testing.T) {
	deterministic := []byte(`{"model":"gpt-4.1","temperature":0,"messages":[{"role":"user","content":"hi"}]}`)

	post := func(target string) *http.Request {
		req, err := http.NewRequest(http.MethodPost, "http://gateway.invalid"+target, nil)
		if err != nil {
			t.Fatal(err)
		}
		return req
	}

	// Everything right: eligible. Without this the rest would pass for a gate that always
	// declines.
	s, _ := cacheGuardServer(t, nil)
	if _, ok := s.chatCacheEligible(post("/v1/chat/completions"), deterministic, nil, "k1"); !ok {
		t.Fatal("a deterministic POST to the chat endpoint was not eligible with the cache on")
	}

	off, _ := cacheGuardServer(t, func(c *config.Config) { c.Cache.ChatEnabled = false })
	if _, ok := off.chatCacheEligible(post("/v1/chat/completions"), deterministic, nil, "k1"); ok {
		t.Error("the chat cache was eligible with the feature switched off")
	}

	if _, ok := s.chatCacheEligible(post("/v1/embeddings"), deterministic, nil, "k1"); ok {
		t.Error("a request to another endpoint was eligible for the chat cache")
	}

	get, err := http.NewRequest(http.MethodGet, "http://gateway.invalid/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.chatCacheEligible(get, deterministic, nil, "k1"); ok {
		t.Error("a GET was eligible for the chat cache")
	}
}

// The scope value is what keeps one caller's cached answer away from another's, and it has
// to hold for a request that carries no auth context at all — which is what an anonymous
// request is.
//
// Under "team" a caller with no team falls back to their own key, not to the shared pool:
// team must never quietly mean global for an unassigned caller, because that is the case
// where an operator believes entries are contained and they are not.
func TestCacheScopeHoldsWithoutAnAuthContext(t *testing.T) {
	cases := []struct {
		scope   string
		authCtx *store.AuthContext
		apiKey  string
		want    string
	}{
		{"team", &store.AuthContext{TeamID: "t_alpha"}, "k1", "team:t_alpha"},
		{"team", &store.AuthContext{TeamID: "  "}, "k1", "key:k1"},
		{"team", &store.AuthContext{}, "k1", "key:k1"},
		{"team", nil, "k1", "key:k1"},
		{"api_key", nil, "k1", "key:k1"},
		{"api_key", &store.AuthContext{TeamID: "t_alpha"}, "k1", "key:k1"},
		{"global", &store.AuthContext{TeamID: "t_alpha"}, "k1", ""},
		{"", nil, "k1", ""},
		{"nonsense", &store.AuthContext{TeamID: "t_alpha"}, "k1", ""},
	}
	for _, tc := range cases {
		got := chatCacheScopeValue(tc.scope, tc.authCtx, tc.apiKey)
		if got != tc.want {
			t.Errorf("scope %q with authCtx %+v gave %q, want %q", tc.scope, tc.authCtx, got, tc.want)
		}
	}
}

// A body with no messages is not a chat request anyone can cache an answer to. Giving it a
// key would put every such request on one entry, and the first response to arrive would be
// served to all of them.
func TestABodyWithoutMessagesHasNoChatCacheKey(t *testing.T) {
	for _, body := range []string{
		`{"model":"gpt-4.1","messages":[],"temperature":0}`,
		`{"model":"gpt-4.1","temperature":0}`,
		`{"messages":[{"role":"user","content":"hi"}],"temperature":0}`,
		`{"temperature":0}`,
		`not json`,
	} {
		if key, _, _ := chatCacheKey([]byte(body)); key != "" {
			t.Errorf("%s produced cache key %q; requests with nothing to cache would share an entry",
				body, key)
		}
	}
	// A real request still gets one.
	if key, _, _ := chatCacheKey([]byte(`{"model":"gpt-4.1","temperature":0,"messages":[{"role":"user","content":"hi"}]}`)); key == "" {
		t.Error("a normal deterministic request produced no cache key")
	}
}
