package proxy

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
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

// End-to-end proof that the breaker takes a dead provider out of the dial path.
// Before it, a broken primary was re-dialled on every single request, paying its
// full timeout each time before failover even began.
func TestProviderBreakerStopsDiallingDeadPrimary(t *testing.T) {
	var primaryHits, backupHits atomic.Int32
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryHits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
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

	cfg := testConfig(backup.URL, "default-secret")
	cfg.Upstream.BreakerEnabled = true
	cfg.Upstream.BreakerThreshold = 2
	cfg.Upstream.BreakerCooldown = time.Hour // long enough that it cannot reopen mid-test
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

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

	call := func() *http.Response {
		t.Helper()
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("shared-model", false))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		return resp
	}

	// Two requests trip the threshold; both fail over and are served by the backup.
	for i := 0; i < 2; i++ {
		resp := call()
		if got := resp.Header.Get("X-Provider"); got != "b-backup" {
			t.Fatalf("request %d: X-Provider=%q, want b-backup", i, got)
		}
		if got := resp.Header.Get("X-Failover-From"); got != "a-primary" {
			t.Fatalf("request %d: expected failover from a-primary, got %q", i, got)
		}
		resp.Body.Close()
	}
	if primaryHits.Load() != 2 {
		t.Fatalf("expected the primary to be dialled twice before opening, got %d", primaryHits.Load())
	}

	// Breaker is now open: further requests must skip the primary entirely and go
	// straight to the backup, with no failover hop to report.
	for i := 0; i < 3; i++ {
		resp := call()
		if got := resp.Header.Get("X-Provider"); got != "b-backup" {
			t.Fatalf("post-open request %d: X-Provider=%q, want b-backup", i, got)
		}
		if got := resp.Header.Get("X-Failover-From"); got != "" {
			t.Fatalf("post-open request %d: expected no failover hop, got X-Failover-From=%q", i, got)
		}
		resp.Body.Close()
	}
	if primaryHits.Load() != 2 {
		t.Fatalf("breaker did not stop dialling the dead primary: %d hits", primaryHits.Load())
	}
	if backupHits.Load() != 5 {
		t.Fatalf("expected all 5 requests served by backup, got %d", backupHits.Load())
	}

	// The admin health view exposes the tripped breaker...
	health, err := http.Get(proxy.URL + "/admin/routing/health")
	if err != nil {
		t.Fatal(err)
	}
	defer health.Body.Close()
	var out struct {
		Breakers struct {
			Enabled bool `json:"enabled"`
			States  []struct {
				Provider string `json:"provider"`
				Phase    string `json:"phase"`
			} `json:"states"`
		} `json:"breakers"`
	}
	if err := json.NewDecoder(health.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Breakers.Enabled {
		t.Fatal("breakers reported as disabled")
	}
	found := false
	for _, st := range out.Breakers.States {
		if st.Provider == "a-primary" && st.Phase == "open" {
			found = true
		}
	}
	if !found {
		t.Fatalf("tripped breaker not surfaced in /admin/routing/health: %+v", out.Breakers.States)
	}

	// ...and a manual reset puts the primary back in the dial path immediately.
	reset := postJSON(t, proxy.URL+"/admin/routing/breaker-reset", "", map[string]any{"provider": "a-primary"})
	if reset.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(reset.Body)
		t.Fatalf("breaker reset failed: %d %s", reset.StatusCode, body)
	}
	reset.Body.Close()

	resp := call()
	resp.Body.Close()
	if primaryHits.Load() != 3 {
		t.Fatalf("reset did not put the primary back in rotation: %d hits", primaryHits.Load())
	}
}

// A failover budget bounds how long the gateway keeps trying alternates. Without it
// a slow primary plus a full candidate list multiplies the caller's wait; with it the
// gateway stops and returns what it has.
func TestFailoverBudgetStopsWalkingCandidates(t *testing.T) {
	var primaryHits, backupHits atomic.Int32
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryHits.Add(1)
		time.Sleep(40 * time.Millisecond) // outlives the tiny budget below
		w.WriteHeader(http.StatusInternalServerError)
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

	cfg := testConfig(backup.URL, "default-secret")
	cfg.Upstream.BreakerEnabled = false // isolate budget behaviour from the breaker
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

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

	send := func(budgetMS string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions",
			bytes.NewReader([]byte(mustJSON(chatBody("shared-model", false)))))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if budgetMS != "" {
			req.Header.Set("X-Failover-Budget-MS", budgetMS)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// No budget: the gateway walks the candidate list and the backup rescues the call.
	noBudget := send("")
	if noBudget.StatusCode != http.StatusOK {
		t.Fatalf("without a budget expected the backup to serve 200, got %d", noBudget.StatusCode)
	}
	if got := noBudget.Header.Get("X-Provider"); got != "b-backup" {
		t.Fatalf("without a budget X-Provider=%q, want b-backup", got)
	}
	noBudget.Body.Close()
	if backupHits.Load() != 1 {
		t.Fatalf("expected the backup to be tried once, got %d", backupHits.Load())
	}

	// Tiny budget: the primary's own latency already exhausts it, so no alternate is
	// dialled and the caller gets the primary's failure instead of a longer wait.
	tight := send("5")
	if tight.StatusCode != http.StatusInternalServerError {
		t.Fatalf("with an exhausted budget expected the primary's 500, got %d", tight.StatusCode)
	}
	if got := tight.Header.Get("X-Provider"); got != "a-primary" {
		t.Fatalf("with an exhausted budget X-Provider=%q, want a-primary", got)
	}
	if got := tight.Header.Get("X-Failover-Path"); !strings.Contains(got, "failover_budget_exhausted") {
		t.Fatalf("X-Failover-Path=%q, want it to record the exhausted budget", got)
	}
	tight.Body.Close()
	if backupHits.Load() != 1 {
		t.Fatalf("budget was exhausted but the backup was dialled anyway: %d hits", backupHits.Load())
	}
	if primaryHits.Load() != 2 {
		t.Fatalf("expected the primary to be dialled on both requests, got %d", primaryHits.Load())
	}
}

// The failover_group is the fix for this gateway's oldest trap: candidates used to come
// only from model_patterns overlap, so the most common setup — a default provider plus
// one vendor-specific provider — silently had no failover at all. Declaring a group must
// create redundancy without forcing the operator to keep their globs identical.
func TestFailoverGroupCreatesRedundancyWithoutOverlappingPatterns(t *testing.T) {
	var primaryHits, backupHits atomic.Int32
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryHits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
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

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Upstream.BreakerEnabled = false
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Deliberately DISJOINT patterns — the old pattern-overlap rule would find no peer.
	// Priority, not name order, decides who is tried first: "z-primary" sorts last.
	upsert := func(name, url, patterns, group string, priority int) {
		t.Helper()
		resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": name, "base_url": url, "api_key": "k", "timeout_ms": 5000, "enabled": true,
			"model_patterns": patterns, "failover_group": group, "priority": priority,
		})
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("upsert %s: %d %s", name, resp.StatusCode, b)
		}
		resp.Body.Close()
	}
	upsert("z-primary", primary.URL, "core-h200", "h200-pool", 10)
	upsert("a-backup", backup.URL, "spare-model", "h200-pool", 20)

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("core-h200", false))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected the group peer to rescue the call, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Provider"); got != "a-backup" {
		t.Fatalf("X-Provider=%q, want a-backup (reached only via the failover group)", got)
	}
	if got := resp.Header.Get("X-Failover-From"); got != "z-primary" {
		t.Fatalf("X-Failover-From=%q, want z-primary", got)
	}
	if primaryHits.Load() != 1 || backupHits.Load() != 1 {
		t.Fatalf("hits primary=%d backup=%d, want 1 each", primaryHits.Load(), backupHits.Load())
	}

	// Priority, not alphabetical order, chose the primary.
	if got := resp.Header.Get("X-Route-Reason"); got != "model_pattern" {
		t.Fatalf("X-Route-Reason=%q, want model_pattern", got)
	}

	// The coverage report must call this out as declared redundancy, not a lucky overlap.
	diag, err := http.Get(proxy.URL + "/admin/routing/pattern-conflicts?model=core-h200")
	if err != nil {
		t.Fatal(err)
	}
	defer diag.Body.Close()
	var out struct {
		Summary struct {
			FailoverReady     int `json:"failover_ready_provider_count"`
			FailoverUncovered int `json:"failover_uncovered_provider_count"`
		} `json:"summary"`
		Coverage []struct {
			Provider      string   `json:"provider"`
			FailoverGroup string   `json:"failover_group"`
			FailoverPeers []string `json:"failover_peers"`
			FailoverReady bool     `json:"failover_ready"`
			PeerSource    string   `json:"peer_source"`
		} `json:"coverage"`
	}
	if err := json.NewDecoder(diag.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Summary.FailoverUncovered != 0 || out.Summary.FailoverReady != 2 {
		t.Fatalf("coverage counts ready=%d uncovered=%d, want 2/0",
			out.Summary.FailoverReady, out.Summary.FailoverUncovered)
	}
	for _, c := range out.Coverage {
		if !c.FailoverReady || c.FailoverGroup != "h200-pool" || c.PeerSource != "failover_group" {
			t.Fatalf("provider %s not reported as group-covered: %+v", c.Provider, c)
		}
		if len(c.FailoverPeers) != 1 {
			t.Fatalf("provider %s peers=%v, want exactly one", c.Provider, c.FailoverPeers)
		}
	}
}

// Priority is the declared attempt order and must beat the historical name ordering.
func TestProviderPriorityOrdersCandidates(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	for _, p := range []struct {
		name     string
		priority int
	}{{"a-third", 30}, {"m-first", 10}, {"z-second", 20}} {
		if err := db.UpsertProvider(ctx, store.ProviderConfig{
			Name: p.name, BaseURL: "http://x.invalid", EncryptedAPIKey: "k",
			TimeoutMS: 1000, Enabled: true, ModelPatterns: "shared-*", Priority: p.priority,
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"m-first", "z-second", "a-third"}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("position %d is %q, want %q (priority must outrank name order)", i, got[i].Name, name)
		}
	}

	// A provider stored before this feature existed has no priority; it must default
	// rather than sort to the front as a zero.
	if err := db.UpsertProvider(ctx, store.ProviderConfig{
		Name: "legacy", BaseURL: "http://x.invalid", EncryptedAPIKey: "k",
		TimeoutMS: 1000, Enabled: true, ModelPatterns: "shared-*",
	}); err != nil {
		t.Fatal(err)
	}
	legacy, found, err := db.GetProvider(ctx, "legacy")
	if err != nil || !found {
		t.Fatalf("legacy provider missing: %v", err)
	}
	if legacy.Priority != store.DefaultProviderPriority {
		t.Fatalf("legacy priority=%d, want the default %d", legacy.Priority, store.DefaultProviderPriority)
	}
	got, err = db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got[len(got)-1].Name != "legacy" {
		t.Fatalf("unprioritised provider sorted to %q, expected last", got[len(got)-1].Name)
	}
}

// Provider health scores were computed and shown for a long time without influencing a
// single routing decision. Demotion is the narrowest useful use of them: a degraded
// provider still answers, so the breaker leaves it alone, yet trying it first costs a
// whole request and its latency. It must move to the back — never be dropped, because a
// lagging average cannot show recovery for a provider that is no longer tried.
func TestHealthDemotesDegradedCandidatesWithoutDroppingThem(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Upstream.HealthDemoteThreshold = 50
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()

	// "sick" earns a poor score: slow, erroring, timing out.
	for i := 0; i < 6; i++ {
		if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
			ID: "sick-" + itoaProxy(i), TraceID: "sick-" + itoaProxy(i), Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "sick", StatusCode: 504, LatencyMS: 9000, Error: "timeout",
			CreatedAt: now.Add(-time.Duration(i) * time.Minute),
		}}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 6; i++ {
		if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
			ID: "well-" + itoaProxy(i), TraceID: "well-" + itoaProxy(i), Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "well", StatusCode: 200, LatencyMS: 90,
			CreatedAt: now.Add(-time.Duration(i) * time.Minute),
		}}); err != nil {
			t.Fatal(err)
		}
	}

	// "sick" is first by declared priority; health must move it behind "well".
	got, demoted := server.demoteUnhealthyCandidates(ctx, []string{"sick", "well"})
	if len(demoted) != 1 || demoted[0] != "sick" {
		t.Fatalf("demoted=%v, want [sick]", demoted)
	}
	if len(got) != 2 || got[0] != "well" || got[1] != "sick" {
		t.Fatalf("order=%v, want [well sick] — degraded last, never removed", got)
	}

	// A provider with no traffic has no evidence against it and must not be demoted.
	got, demoted = server.demoteUnhealthyCandidates(ctx, []string{"well", "brand-new"})
	if len(demoted) != 0 {
		t.Fatalf("a provider with no history was demoted: %v", demoted)
	}
	if len(got) != 2 || got[0] != "well" {
		t.Fatalf("order changed with nothing to demote: %v", got)
	}

	// Threshold 0 disables the feature outright, leaving priority order untouched.
	server.cfg.Upstream.HealthDemoteThreshold = 0
	got, demoted = server.demoteUnhealthyCandidates(ctx, []string{"sick", "well"})
	if len(demoted) != 0 || got[0] != "sick" {
		t.Fatalf("threshold 0 should disable demotion, got order=%v demoted=%v", got, demoted)
	}
}

// The drill exists so redundancy can be proven before an outage, not during one.
func TestFailoverDrillReportsWhoWouldServe(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig("http://unused.invalid", "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, p := range []struct {
		name     string
		priority int
	}{{"pool-a", 10}, {"pool-b", 20}} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
			"name": p.name, "base_url": "http://" + p.name + ".invalid", "api_key": "k",
			"timeout_ms": 5000, "enabled": true, "model_patterns": "core-h200",
			"failover_group": "h200-pool", "priority": p.priority,
		})
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("upsert %s: %d %s", p.name, resp.StatusCode, b)
		}
		resp.Body.Close()
	}

	drill := func(model string, fail []string) map[string]any {
		t.Helper()
		resp := postJSON(t, proxy.URL+"/admin/routing/failover-drill", "", map[string]any{"model": model, "fail": fail})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("drill failed: %d %s", resp.StatusCode, b)
		}
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// Nothing failed: the highest-priority provider serves.
	out := drill("core-h200", nil)
	if out["served_by"] != "pool-a" || out["outcome"] != "served" {
		t.Fatalf("baseline drill: served_by=%v outcome=%v, want pool-a/served", out["served_by"], out["outcome"])
	}

	// Kill the primary: the group peer must take over.
	out = drill("core-h200", []string{"pool-a"})
	if out["served_by"] != "pool-b" || out["outcome"] != "served" {
		t.Fatalf("with pool-a down: served_by=%v outcome=%v, want pool-b/served", out["served_by"], out["outcome"])
	}
	steps, _ := out["steps"].([]any)
	if len(steps) != 2 {
		t.Fatalf("expected two steps, got %v", out["steps"])
	}
	if first, _ := steps[0].(map[string]any); first["outcome"] != "simulated_failure" {
		t.Fatalf("first step should be the simulated failure, got %v", steps[0])
	}

	// Kill both: the drill must say the pool is exhausted and suggest the fix.
	out = drill("core-h200", []string{"pool-a", "pool-b"})
	if out["outcome"] != "exhausted" || out["served_by"] != "" {
		t.Fatalf("with both down: outcome=%v served_by=%v, want exhausted/empty", out["outcome"], out["served_by"])
	}
	if advice, _ := out["advice"].(string); !strings.Contains(advice, "failover_group") {
		t.Fatalf("advice should point at failover_group, got %q", advice)
	}

	// A model no pattern matches falls through to the default provider, which is never
	// a failover candidate — the drill has to surface that as a lack of redundancy.
	out = drill("unmatched-model", nil)
	if out["outcome"] != "no_redundancy" {
		t.Fatalf("unmatched model: outcome=%v, want no_redundancy (%v)", out["outcome"], out["advice"])
	}
}
