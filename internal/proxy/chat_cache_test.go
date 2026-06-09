package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func newChatCacheServer(t *testing.T, hits *atomic.Int32) (*httptest.Server, *store.SQLStore, func()) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"cached answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`))
	}))
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	cfg := testConfig(upstream.URL, "secret")
	cfg.Cache.ChatEnabled = true
	cfg.Cache.ChatTTL = time.Hour
	cfg.Cache.EmbeddingMaxBytes = 1 << 20
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	cleanup := func() { proxy.Close(); logger.Stop(context.Background()); db.Close(); upstream.Close() }
	return proxy, db, cleanup
}

func TestChatCacheHitOnDeterministicRequest(t *testing.T) {
	var hits atomic.Int32
	proxy, db, cleanup := newChatCacheServer(t, &hits)
	defer cleanup()

	body := map[string]any{
		"model":       "gpt-4.1",
		"temperature": 0,
		"messages":    []any{map[string]any{"role": "user", "content": "2+2?"}},
	}
	first := postJSON(t, proxy.URL+"/v1/chat/completions", "", body)
	first.Body.Close()
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first: expected 200, got %d", first.StatusCode)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 upstream hit, got %d", hits.Load())
	}
	// allow async store
	time.Sleep(80 * time.Millisecond)

	second := postJSON(t, proxy.URL+"/v1/chat/completions", "", body)
	defer second.Body.Close()
	if second.Header.Get("X-Cache") != "HIT" {
		t.Fatalf("expected X-Cache=HIT on second deterministic request, got %q", second.Header.Get("X-Cache"))
	}
	if hits.Load() != 1 {
		t.Fatalf("cache hit must NOT call upstream again; hits=%d", hits.Load())
	}
	_ = db
}

func TestChatCacheSkipsNonDeterministic(t *testing.T) {
	var hits atomic.Int32
	proxy, _, cleanup := newChatCacheServer(t, &hits)
	defer cleanup()

	// no temperature → non-deterministic → must NOT cache (without opt-in header)
	body := map[string]any{
		"model":    "gpt-4.1",
		"messages": []any{map[string]any{"role": "user", "content": "tell me a joke"}},
	}
	for i := 0; i < 2; i++ {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", body)
		resp.Body.Close()
		time.Sleep(40 * time.Millisecond)
	}
	if hits.Load() != 2 {
		t.Fatalf("non-deterministic requests must always hit upstream; hits=%d", hits.Load())
	}
}

func TestChatCacheOptInHeader(t *testing.T) {
	var hits atomic.Int32
	proxy, _, cleanup := newChatCacheServer(t, &hits)
	defer cleanup()

	mk := func() *http.Response {
		req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", jsonReader(map[string]any{
			"model":    "gpt-4.1",
			"messages": []any{map[string]any{"role": "user", "content": "opt in please"}},
		}))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Proxy-Cache", "1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	mk().Body.Close()
	time.Sleep(80 * time.Millisecond)
	second := mk()
	defer second.Body.Close()
	if second.Header.Get("X-Cache") != "HIT" {
		t.Fatalf("opt-in header should enable caching; got X-Cache=%q", second.Header.Get("X-Cache"))
	}
	if hits.Load() != 1 {
		t.Fatalf("opt-in cache hit must not re-call upstream; hits=%d", hits.Load())
	}
}

func TestChatCacheKeyDeterminism(t *testing.T) {
	a := []byte(`{"model":"m","temperature":0,"messages":[{"role":"user","content":"hi"}]}`)
	b := []byte(`{"model":"m","temperature":0,"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	ka, _, detA := chatCacheKey(a)
	kb, _, _ := chatCacheKey(b)
	if ka == "" || ka != kb {
		t.Fatalf("stream-only difference must not change key: %q vs %q", ka, kb)
	}
	if !detA {
		t.Fatal("temperature 0 should be deterministic")
	}
	c := []byte(`{"model":"m","temperature":0,"messages":[{"role":"user","content":"different"}]}`)
	kc, _, _ := chatCacheKey(c)
	if kc == ka {
		t.Fatal("different messages must change key")
	}
}
