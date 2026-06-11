package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestIntelligentScorersClassifyComplexityAndRisk(t *testing.T) {
	simple := analyzeComplexity([]store.PromptLog{{RedactedText: "hi"}}, 0)
	if simple.Score >= 30 || simple.Tier != "simple" {
		t.Fatalf("expected simple prompt score <30, got %#v", simple)
	}
	complexPrompt := strings.Repeat("architecture design tradeoff refactor debug internal/service.go internal/api.go internal/auth.go\nfunc main() { return }\n", 220)
	complex := analyzeComplexity([]store.PromptLog{{RedactedText: complexPrompt}}, 10)
	if complex.Score < 60 || complex.FileCount < 2 || complex.CodeDensity <= 0 {
		t.Fatalf("expected complex coding prompt, got %#v", complex)
	}
	risk := analyzeRisk([]store.PromptLog{{RedactedText: `password=[REDACTED] terraform apply kubectl apply jwt authentication authorization`}})
	if risk.Score < 60 || len(risk.Categories) < 3 {
		t.Fatalf("expected high risk categories, got %#v", risk)
	}
}

func TestAutoRouterRewritesModelAndStoresDecision(t *testing.T) {
	var seenModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var root map[string]any
		_ = json.Unmarshal(body, &root)
		seenModel, _ = root["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`))
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

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "auto",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Routed-Model") != "gpt-4.1-mini" {
		t.Fatalf("expected auto to route to gpt-4.1-mini, got %q", resp.Header.Get("X-Routed-Model"))
	}
	resp.Body.Close()
	if seenModel != "gpt-4.1-mini" {
		t.Fatalf("upstream saw model %q", seenModel)
	}

	waitFor(t, time.Second, func() bool {
		decisions, _ := db.ListRoutingDecisions(context.Background(), 10)
		return len(decisions) == 1
	})
	decisions, err := db.ListRoutingDecisions(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) != 1 {
		t.Fatalf("expected one routing decision, got %#v", decisions)
	}
	got := decisions[0]
	if got.RequestedModel != "auto" || got.SelectedModel != "gpt-4.1-mini" || got.Complexity.Tier != "simple" {
		t.Fatalf("unexpected routing decision: %#v", got)
	}
	if got.DecisionReason == "" || got.HealthScore <= 0 {
		t.Fatalf("expected explain reason and health score: %#v", got)
	}
}

func TestRoutingPreviewAndHealthAPIs(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	preview := postJSON(t, proxy.URL+"/admin/routing/preview", "", map[string]any{
		"model": "vibe-coders/auto",
		"messages": []any{
			map[string]any{"role": "user", "content": "refactor auth middleware and check password=[REDACTED]"},
		},
	})
	defer preview.Body.Close()
	if preview.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(preview.Body)
		t.Fatalf("preview failed: %d %s", preview.StatusCode, body)
	}
	var out struct {
		RequestedModel string             `json:"requested_model"`
		SelectedModel  string             `json:"selected_model"`
		Risk           store.RiskAnalysis `json:"risk"`
		FallbackPath   []string           `json:"fallback_path"`
		WouldRewrite   bool               `json:"would_rewrite"`
	}
	if err := json.NewDecoder(preview.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.RequestedModel != "vibe-coders/auto" || out.SelectedModel == "" || !out.WouldRewrite || out.Risk.Score == 0 {
		t.Fatalf("unexpected preview: %#v", out)
	}
	if len(out.FallbackPath) != 1 || out.FallbackPath[0] != "fallback_disabled:sensitive_data" {
		t.Fatalf("expected sensitive fallback disabled, got %#v", out.FallbackPath)
	}

	health, err := http.Get(proxy.URL + "/admin/routing/health?window=1h")
	if err != nil {
		t.Fatal(err)
	}
	defer health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("expected health status 200, got %d", health.StatusCode)
	}
}

func TestStatusFallbackOn429UsesBackupProvider(t *testing.T) {
	alphaHit := make(chan struct{}, 1)
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		alphaHit <- struct{}{}
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer alpha.Close()

	zetaHit := make(chan struct{}, 1)
	zeta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		zetaHit <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer zeta.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(alpha.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, p := range []map[string]any{
		{"name": "alpha", "base_url": alpha.URL, "api_key": "a", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
		{"name": "zeta", "base_url": zeta.URL, "api_key": "z", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
	} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", p)
		resp.Body.Close()
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("foo-1", false))
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected fallback 200, got %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()
	select {
	case <-alphaHit:
	case <-time.After(time.Second):
		t.Fatal("expected alpha provider hit")
	}
	select {
	case <-zetaHit:
	case <-time.After(time.Second):
		t.Fatal("expected zeta provider fallback hit")
	}

	waitFor(t, time.Second, func() bool {
		recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return len(recent) == 1 && recent[0].Provider == "zeta"
	})
	recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if recent[0].Provider != "zeta" {
		t.Fatalf("expected final provider zeta, got %#v", recent[0])
	}
	explain, err := db.ExplainRow(context.Background(), recent[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !explain.Failover || !strings.Contains(explain.FallbackReason, "429") {
		t.Fatalf("expected 429 failover explain, got %#v", explain)
	}
}
