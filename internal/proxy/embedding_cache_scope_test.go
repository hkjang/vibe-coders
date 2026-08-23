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

// Who an embedding cache entry may be served to.
//
// This cache is on by default, unlike the chat one, so whatever it does applies to every
// deployment. What it does is share: the key is (model, input), so an identical input
// from any caller hits the same entry regardless of team.
//
// The exposure is smaller than the chat cache's and it is worth being precise about why.
// An embedding is a pure function of its input, and the caller supplied that input, so a
// shared hit returns exactly what a fresh call would have returned. Nothing of the other
// team's content comes back. What sharing still reveals is that somebody embedded this
// exact text before — for a pipeline that indexes documents, a fact about another team's
// corpus. CACHE_EMBEDDING_SCOPE exists for deployments where that matters; global stays
// the default because the saving is real and the leak is narrow.

func runEmbeddingScope(t *testing.T, scope string) (firstCache, secondCache, secondBody string, upstreamCalls int64) {
	t.Helper()

	// A different vector per call, so a hit is visible in the body rather than only in a
	// header — with a fixed answer the content check would pass on a miss too.
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"embedding":[0.1,0.2,%d],"index":0}],"usage":{"prompt_tokens":3,"total_tokens":3}}`, n)
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
	cfg.Cache.EmbeddingEnabled = true
	cfg.Cache.EmbeddingTTL = time.Hour
	// Without this the cache stores nothing at all, and every assertion below would pass
	// for the wrong reason.
	cfg.Cache.EmbeddingMaxBytes = 1 << 20
	cfg.Cache.EmbeddingScope = scope
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	payload, _ := json.Marshal(map[string]any{"model": "test-embed", "input": "confidential board memo"})
	call := func(secret string) (string, string) {
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/embeddings", bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+secret)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		resp.Body.Close()
		return resp.Header.Get("X-Cache"), string(body)
	}

	firstCache, _ = call("sk-alice")
	secondCache, secondBody = call("sk-mallory")
	return firstCache, secondCache, secondBody, calls.Load()
}

func TestEmbeddingCacheIsSharedAcrossTeamsByDefault(t *testing.T) {
	first, second, body, calls := runEmbeddingScope(t, "global")
	if first == "HIT" {
		t.Fatal("the first caller hit the cache, so the fixture is not starting empty")
	}
	if second != "HIT" {
		t.Errorf("with the default scope the second caller got X-Cache=%q, want HIT — this "+
			"cache is shared and on by default, and this test exists to notice if that changes", second)
	}
	if !strings.Contains(body, "0.2,1") {
		t.Errorf("the second caller did not receive the first caller's cached vector: %s", body)
	}
	if calls != 1 {
		t.Errorf("upstream was called %d times; a shared cache should have served the second request", calls)
	}
}

func TestEmbeddingCacheScopeTeamKeepsEntriesInsideTheTeam(t *testing.T) {
	first, second, body, calls := runEmbeddingScope(t, "team")
	if first == "HIT" {
		t.Fatal("the first caller hit the cache, so the fixture is not starting empty")
	}
	if second == "HIT" {
		t.Error("with scope=team a caller on team-beta hit an entry stored by team-alpha")
	}
	if !strings.Contains(body, "0.2,2") {
		t.Errorf("the second caller should have been served fresh from upstream, got: %s", body)
	}
	if calls != 2 {
		t.Errorf("upstream was called %d times; with the cache scoped per team both requests must reach it", calls)
	}
}
