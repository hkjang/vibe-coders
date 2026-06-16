package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestClampMaxOutputTokens(t *testing.T) {
	// Over the cap → reduced.
	out, from, to, changed := clampMaxOutputTokens([]byte(`{"model":"m","max_tokens":9000}`), 4096)
	if !changed || from != 9000 || to != 4096 {
		t.Fatalf("over-cap clamp = %v from=%d to=%d", changed, from, to)
	}
	var root map[string]any
	_ = json.Unmarshal(out, &root)
	if int(root["max_tokens"].(float64)) != 4096 {
		t.Fatalf("max_tokens not clamped: %v", root["max_tokens"])
	}

	// Absent → injected (from = -1).
	_, from, to, changed = clampMaxOutputTokens([]byte(`{"model":"m"}`), 4096)
	if !changed || from != -1 || to != 4096 {
		t.Fatalf("inject = %v from=%d to=%d", changed, from, to)
	}

	// Under the cap → unchanged.
	if _, _, _, changed = clampMaxOutputTokens([]byte(`{"model":"m","max_tokens":100}`), 4096); changed {
		t.Fatal("under-cap should not change")
	}

	// max_completion_tokens variant.
	if _, from, _, changed = clampMaxOutputTokens([]byte(`{"model":"m","max_completion_tokens":8000}`), 2048); !changed || from != 8000 {
		t.Fatalf("max_completion_tokens clamp = %v from=%d", changed, from)
	}

	// Disabled (cap 0) → no-op.
	if _, _, _, changed = clampMaxOutputTokens([]byte(`{"model":"m","max_tokens":9000}`), 0); changed {
		t.Fatal("cap 0 should be a no-op")
	}
}

func TestLimitsMaxRequestBytes(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "lb.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.limitsRuntime.Store(&config.LimitsConfig{MaxRequestBytes: 200})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	big := make([]map[string]string, 0)
	for i := 0; i < 50; i++ {
		big = append(big, map[string]string{"role": "user", "content": "this is a fairly long message used to exceed the byte limit"})
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", jsonReader(map[string]any{"model": "gpt-4o", "messages": big}))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request = %d, want 413", resp.StatusCode)
	}
	if resp.Header.Get("X-Request-Bytes") == "" {
		t.Fatal("expected X-Request-Bytes header")
	}
}

func TestLimitsStepForwardsClamped(t *testing.T) {
	var seenMax float64 = -42
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var root map[string]any
		_ = json.Unmarshal(b, &root)
		if v, ok := root["max_tokens"].(float64); ok {
			seenMax = v
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "lim.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.limitsRuntime.Store(&config.LimitsConfig{MaxOutputTokens: 512})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", jsonReader(map[string]any{
		"model": "gpt-4o", "max_tokens": 100000, "messages": []map[string]string{{"role": "user", "content": "hi"}},
	}))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Max-Tokens-Clamped") != "100000->512" {
		t.Fatalf("clamp header = %q", resp.Header.Get("X-Max-Tokens-Clamped"))
	}
	if seenMax != 512 {
		t.Fatalf("upstream should receive clamped max_tokens=512, got %v", seenMax)
	}
}
