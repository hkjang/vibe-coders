package proxy

import (
	"context"
	"encoding/csv"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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
