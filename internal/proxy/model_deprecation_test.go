package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSunsetReached(t *testing.T) {
	now, err := time.Parse(time.RFC3339, "2026-06-16T12:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if sunsetReached("", now) {
		t.Fatal("empty sunset date is never reached")
	}
	if sunsetReached("2026-06-17", now) {
		t.Fatal("future date should not be reached")
	}
	if !sunsetReached("2026-06-16", now) {
		t.Fatal("today should be reached")
	}
	if !sunsetReached("2026-01-01", now) {
		t.Fatal("past date should be reached")
	}
}

func TestModelDeprecationPipeline(t *testing.T) {
	var seenModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var root struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(b, &root)
		seenModel = root.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "md.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()
	ctx := context.Background()

	chat := func(model string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", jsonReader(map[string]any{
			"model": model, "messages": []map[string]string{{"role": "user", "content": "hi"}},
		}))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// 1) Warn-only (no sunset date): header set, model forwarded unchanged.
	if _, err := db.UpsertModelDeprecation(ctx, store.ModelDeprecation{ModelGlob: "old-*", Replacement: "new-model", Message: "use new-model"}); err != nil {
		t.Fatal(err)
	}
	resp := chat("old-mini")
	if resp.Header.Get("X-Model-Deprecated") != "old-mini" || resp.Header.Get("X-Model-Replacement") != "new-model" {
		t.Fatalf("warn headers wrong: dep=%q rep=%q", resp.Header.Get("X-Model-Deprecated"), resp.Header.Get("X-Model-Replacement"))
	}
	resp.Body.Close()
	if seenModel != "old-mini" {
		t.Fatalf("warn-only must not rewrite, upstream saw %q", seenModel)
	}

	// 2) Past sunset with replacement → rewritten to replacement.
	if _, err := db.UpsertModelDeprecation(ctx, store.ModelDeprecation{ModelGlob: "gone-*", Replacement: "successor", SunsetDate: "2000-01-01"}); err != nil {
		t.Fatal(err)
	}
	server.invalidateDeprecationCache()
	resp = chat("gone-1")
	if resp.Header.Get("X-Model-Sunset-Rewritten") != "successor" {
		t.Fatalf("expected rewrite header, got %q", resp.Header.Get("X-Model-Sunset-Rewritten"))
	}
	resp.Body.Close()
	if seenModel != "successor" {
		t.Fatalf("past-sunset should rewrite to successor, upstream saw %q", seenModel)
	}

	// 3) Past sunset, no replacement → blocked.
	if _, err := db.UpsertModelDeprecation(ctx, store.ModelDeprecation{ModelGlob: "dead-*", SunsetDate: "2000-01-01"}); err != nil {
		t.Fatal(err)
	}
	server.invalidateDeprecationCache()
	resp = chat("dead-9")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("retired model with no replacement should 400, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
