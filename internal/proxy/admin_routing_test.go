package proxy

import (
	"bytes"
	"context"
	"encoding/csv"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestModelPatternsRouteToMatchingProvider(t *testing.T) {
	openaiHit := make(chan struct{}, 1)
	openaiUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		openaiHit <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"openai"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer openaiUpstream.Close()

	anthropicHit := make(chan struct{}, 1)
	anthropicUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		anthropicHit <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"claude"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}`))
	}))
	defer anthropicUpstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(openaiUpstream.URL, "openai-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// add anthropic provider with claude-* pattern
	resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":           "anthropic",
		"base_url":       anthropicUpstream.URL,
		"api_key":        "anthropic-secret",
		"timeout_ms":     5000,
		"enabled":        true,
		"model_patterns": "claude-*,anthropic/*",
	})
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("provider upsert failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	// claude-* should auto-route to anthropic
	r1 := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("claude-3-5-sonnet", false))
	if r1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for claude model, got %d", r1.StatusCode)
	}
	r1.Body.Close()
	select {
	case <-anthropicHit:
	case <-time.After(time.Second):
		t.Fatal("expected anthropic upstream to be called")
	}
	select {
	case <-openaiHit:
		t.Fatal("openai upstream should not have been called for claude model")
	default:
	}

	// gpt-4.1 should fall back to default (openai/test)
	r2 := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("gpt-4.1-mini", false))
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for gpt model, got %d", r2.StatusCode)
	}
	r2.Body.Close()
	select {
	case <-openaiHit:
	case <-time.After(time.Second):
		t.Fatal("expected default openai upstream to be called for gpt model")
	}
}

// Embedding requests (/v1/embeddings) must flow through the same provider
// selection as chat: routed by model glob to the matching upstream (e.g. an
// OpenAI-style default vs. a local vLLM/Ollama server), forwarded verbatim to
// {base_url}/v1/embeddings, and the response relayed back to the caller.
func TestEmbeddingsRouteToMatchingProviderByModel(t *testing.T) {
	type call struct{ path string }

	defaultHit := make(chan call, 1)
	defaultUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defaultHit <- call{path: r.URL.Path}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2,0.3]}],"model":"text-embedding-3-small","usage":{"prompt_tokens":3,"total_tokens":3}}`))
	}))
	defer defaultUpstream.Close()

	// Stands in for a local vLLM/Ollama server exposing OpenAI-compatible embeddings.
	localHit := make(chan call, 1)
	localUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		localHit <- call{path: r.URL.Path}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.4,0.5]}],"model":"nomic-embed-text","usage":{"prompt_tokens":3,"total_tokens":3}}`))
	}))
	defer localUpstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(defaultUpstream.URL, "openai-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Register the local embedding provider with globs for common local embed models.
	resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":           "ollama",
		"base_url":       localUpstream.URL,
		"api_key":        "ollama-secret",
		"timeout_ms":     5000,
		"enabled":        true,
		"model_patterns": "nomic-embed-*,bge-*,mxbai-embed-*",
	})
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("provider upsert failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	// A local embed model auto-routes to the ollama provider.
	r1 := postJSON(t, proxy.URL+"/v1/embeddings", "", map[string]any{"model": "nomic-embed-text", "input": "hello"})
	if r1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for nomic-embed-text, got %d", r1.StatusCode)
	}
	r1.Body.Close()
	select {
	case c := <-localHit:
		if c.path != "/v1/embeddings" {
			t.Fatalf("expected local upstream to receive /v1/embeddings, got %q", c.path)
		}
	case <-time.After(time.Second):
		t.Fatal("expected local (ollama) upstream to be called for nomic-embed-text")
	}
	select {
	case <-defaultHit:
		t.Fatal("default upstream should not be called for a local embed model")
	default:
	}

	// An OpenAI embed model falls back to the default provider.
	r2 := postJSON(t, proxy.URL+"/v1/embeddings", "", map[string]any{"model": "text-embedding-3-small", "input": "world"})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for text-embedding-3-small, got %d", r2.StatusCode)
	}
	r2.Body.Close()
	select {
	case c := <-defaultHit:
		if c.path != "/v1/embeddings" {
			t.Fatalf("expected default upstream to receive /v1/embeddings, got %q", c.path)
		}
	case <-time.After(time.Second):
		t.Fatal("expected default upstream to be called for text-embedding-3-small")
	}
}

func TestDefaultProviderBootstrapPreservesAdminModelPatterns(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	if _, err := NewServer(cfg, db, logger, nil); err != nil {
		t.Fatal(err)
	}
	provider, found, err := db.GetProvider(context.Background(), cfg.Upstream.Provider)
	if err != nil || !found {
		t.Fatalf("default provider missing: found=%v err=%v", found, err)
	}
	provider.ModelPatterns = "admin-model-*"
	if err := db.UpsertProvider(context.Background(), provider); err != nil {
		t.Fatal(err)
	}

	// A restart must not erase the pattern saved through the admin provider form.
	if _, err := NewServer(cfg, db, logger, nil); err != nil {
		t.Fatal(err)
	}
	provider, found, err = db.GetProvider(context.Background(), cfg.Upstream.Provider)
	if err != nil || !found {
		t.Fatalf("default provider missing after restart: found=%v err=%v", found, err)
	}
	if provider.ModelPatterns != "admin-model-*" {
		t.Fatalf("admin model patterns were overwritten: %q", provider.ModelPatterns)
	}

	// An explicit environment-derived value remains authoritative.
	cfg.Upstream.ModelPatterns = "env-model-*"
	if _, err := NewServer(cfg, db, logger, nil); err != nil {
		t.Fatal(err)
	}
	provider, _, err = db.GetProvider(context.Background(), cfg.Upstream.Provider)
	if err != nil {
		t.Fatal(err)
	}
	if provider.ModelPatterns != "env-model-*" {
		t.Fatalf("environment model patterns were not applied: %q", provider.ModelPatterns)
	}
}

func TestCachedAndReasoningTokensTrackedAndCostedSeparately(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],
			"usage":{
				"prompt_tokens": 1000,
				"completion_tokens": 100,
				"total_tokens": 1100,
				"prompt_tokens_details": { "cached_tokens": 800 },
				"completion_tokens_details": { "reasoning_tokens": 50 }
			}
		}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Pricing = map[string]config.ModelPrice{
		"test-model": {
			InputKRWPer1M:       1_000_000, // 1 KRW / token
			OutputKRWPer1M:      2_000_000, // 2 KRW / token
			CachedInputKRWPer1M: 100_000,   // 0.1 KRW / cached token
		},
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	waitFor(t, time.Second, func() bool {
		stats, err := db.Summary(context.Background())
		return err == nil && stats.TotalRequests == 1
	})

	// Pull recent request and verify cached/reasoning columns + cost
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 {
		t.Fatalf("expected 1 recent request, got %d", len(recent))
	}
	got := recent[0]
	if got.CachedTokens != 800 {
		t.Fatalf("expected cached_tokens=800, got %d", got.CachedTokens)
	}
	if got.ReasoningTokens != 50 {
		t.Fatalf("expected reasoning_tokens=50, got %d", got.ReasoningTokens)
	}
	// expected cost:
	//   fresh prompt: 200 * 1 = 200
	//   cached: 800 * 0.1 = 80
	//   output: (100 + 50) * 2 = 300
	//   total = 580 KRW
	if got.EstimatedCost < 579 || got.EstimatedCost > 581 {
		t.Fatalf("expected cost ~580, got %.4f", got.EstimatedCost)
	}
}

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pattern, value string
		want           bool
	}{
		{"*", "anything", true},
		{"claude-*", "claude-3-5-sonnet", true},
		{"claude-*", "gpt-4", false},
		{"anthropic/*", "anthropic/claude", true},
		{"*-mini", "gpt-4.1-mini", true},
		{"*-mini", "gpt-4.1-pro", false},
		{"gpt-4.1-mini", "gpt-4.1-mini", true},
		{"gpt-4.1-mini", "gpt-4.1-nano", false},
		{"*o3*", "openai/o3-mini", true},
	}
	for _, tc := range cases {
		if got := matchGlob(tc.pattern, tc.value); got != tc.want {
			t.Errorf("matchGlob(%q,%q)=%v want %v", tc.pattern, tc.value, got, tc.want)
		}
	}
}

func TestExportCSVReturnsAuditRows(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for i := 0; i < 2; i++ {
		r := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
		if r.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", r.StatusCode)
		}
		r.Body.Close()
	}

	waitFor(t, time.Second, func() bool {
		stats, _ := db.Summary(context.Background())
		return stats.TotalRequests == 2
	})

	resp, err := http.Get(proxy.URL + "/admin/export.csv?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("expected text/csv, got %s", ct)
	}

	body, _ := io.ReadAll(resp.Body)
	// strip BOM
	if len(body) >= 3 && body[0] == 0xEF && body[1] == 0xBB && body[2] == 0xBF {
		body = body[3:]
	}
	reader := csv.NewReader(strings.NewReader(string(body)))
	rows, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("csv parse failed: %v", err)
	}
	if len(rows) < 3 { // header + 2 data rows
		t.Fatalf("expected at least 3 csv rows (header + data), got %d", len(rows))
	}
	if rows[0][0] != "created_at" {
		t.Fatalf("expected first column to be created_at, got %q", rows[0][0])
	}
}

// The response must say which upstream actually answered and why it was picked.
// Before these headers the only routing signal a client ever saw was X-Failover-From,
// so "which provider served this?" could not be answered without the admin UI.
func TestRoutingHeadersExposeProviderAndFailover(t *testing.T) {
	var primaryHits, backupHits atomic.Int32
	// Alphabetically first, so it is the primary; always rate-limits.
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryHits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer primary.Close()
	backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backupHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer backup.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(backup.URL, "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Two providers matching the same glob — the only configuration in which the
	// gateway builds failover candidates at all.
	for _, p := range []struct{ name, url string }{{"a-primary", primary.URL}, {"b-backup", backup.URL}} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": p.name, "base_url": p.url, "api_key": "secret",
			"timeout_ms": 5000, "enabled": true, "model_patterns": "shared-*",
		})
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("provider %s upsert failed: %d %s", p.name, resp.StatusCode, body)
		}
		resp.Body.Close()
	}

	t.Run("failover exposes origin and cause", func(t *testing.T) {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("shared-model", false))
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 after failover, got %d", resp.StatusCode)
		}
		if primaryHits.Load() != 1 || backupHits.Load() != 1 {
			t.Fatalf("expected one hit each, got primary=%d backup=%d", primaryHits.Load(), backupHits.Load())
		}
		if got := resp.Header.Get("X-Provider"); got != "b-backup" {
			t.Fatalf("X-Provider=%q, want b-backup (the provider that actually answered)", got)
		}
		if got := resp.Header.Get("X-Route-Reason"); got != "model_pattern" {
			t.Fatalf("X-Route-Reason=%q, want model_pattern", got)
		}
		if got := resp.Header.Get("X-Route-Detail"); got != "shared-*" {
			t.Fatalf("X-Route-Detail=%q, want the matched glob shared-*", got)
		}
		if got := resp.Header.Get("X-Failover-From"); got != "a-primary" {
			t.Fatalf("X-Failover-From=%q, want a-primary", got)
		}
		if got := resp.Header.Get("X-Failover-Reason"); !strings.Contains(got, "429") {
			t.Fatalf("X-Failover-Reason=%q, want it to name the 429 that triggered failover", got)
		}
		if got := resp.Header.Get("X-Failover-Path"); !strings.Contains(got, "a-primary->b-backup") {
			t.Fatalf("X-Failover-Path=%q, want the a-primary->b-backup hop", got)
		}
	})

	t.Run("no failover means no failover headers", func(t *testing.T) {
		// Pinning a provider disables failover entirely, so only selection headers appear.
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader([]byte(mustJSON(chatBody("shared-model", false)))))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Proxy-Provider", "b-backup")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		if got := resp.Header.Get("X-Provider"); got != "b-backup" {
			t.Fatalf("X-Provider=%q, want b-backup", got)
		}
		if got := resp.Header.Get("X-Route-Reason"); got != "header" {
			t.Fatalf("X-Route-Reason=%q, want header", got)
		}
		if got := resp.Header.Get("X-Failover-From"); got != "" {
			t.Fatalf("X-Failover-From=%q, want empty when nothing failed over", got)
		}
		if got := resp.Header.Get("X-Failover-Path"); got != "" {
			t.Fatalf("X-Failover-Path=%q, want empty when nothing failed over", got)
		}
	})
}
