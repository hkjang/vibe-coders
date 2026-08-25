package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

// When CACHE_EMBEDDING_BASE_URL is set, embedText must call that endpoint directly
// (at /v1/embeddings) with its own API key, bypassing normal provider selection.
func TestEmbedTextUsesDedicatedEndpoint(t *testing.T) {
	var gotPath, gotAuth string
	embed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2,0.3]}]}`))
	}))
	defer embed.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Cache.ChatSemanticEnabled = true
	cfg.Cache.ChatSemanticModel = "embed-model"
	cfg.Cache.EmbeddingBaseURL = embed.URL
	cfg.Cache.EmbeddingAPIKey = "embed-key"

	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	vec, err := server.embedText(context.Background(), req, cfg.Cache.ChatSemanticModel, "hello world")
	if err != nil {
		t.Fatalf("embedText errored: %v", err)
	}
	if len(vec) != 3 {
		t.Fatalf("expected 3-dim embedding, got %#v", vec)
	}
	if gotPath != "/v1/embeddings" {
		t.Fatalf("expected /v1/embeddings, got %q", gotPath)
	}
	if gotAuth != "Bearer embed-key" {
		t.Fatalf("expected dedicated embedding key auth, got %q", gotAuth)
	}
}
