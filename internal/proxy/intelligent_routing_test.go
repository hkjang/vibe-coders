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
	standard := analyzeComplexity([]store.PromptLog{{RedactedText: "implement a small parser in parser.go with tests"}}, 1)
	if standard.Score < 30 || standard.Score >= 60 || standard.Tier != "standard" {
		t.Fatalf("expected standard coding prompt, got %#v", standard)
	}
	complexPrompt := strings.Repeat("architecture design tradeoff refactor debug internal/service.go internal/api.go internal/auth.go\nfunc main() { return }\n", 220)
	complex := analyzeComplexity([]store.PromptLog{{RedactedText: complexPrompt}}, 10)
	if complex.Score < 60 || complex.FileCount < 2 || complex.CodeDensity <= 0 {
		t.Fatalf("expected complex coding prompt, got %#v", complex)
	}
	reasoning := analyzeComplexity([]store.PromptLog{{RedactedText: "Design the distributed architecture, compare consistency tradeoff, scalability, and failure modes."}}, 0)
	if reasoning.Score < 85 || reasoning.Tier != "reasoning" {
		t.Fatalf("expected reasoning architecture prompt, got %#v", reasoning)
	}
	risk := analyzeRisk([]store.PromptLog{{RedactedText: `password=[REDACTED] terraform apply kubectl apply jwt authentication authorization`}})
	if risk.Score < 60 || len(risk.Categories) < 3 {
		t.Fatalf("expected high risk categories, got %#v", risk)
	}
	critical := analyzeRisk([]store.PromptLog{{RedactedText: `[REDACTED_OPENAI_KEY] AKIA1234567890ABCDEF password=[REDACTED] terraform destroy sudo rm -rf /`}})
	if critical.Score < 80 || critical.Tier != "critical" || !riskDisablesFallback(critical) {
		t.Fatalf("expected critical secret risk to disable fallback, got %#v", critical)
	}
}

func TestFallbackReasonHelpersAndForbiddenStatuses(t *testing.T) {
	if !statusFallbackAllowed(http.StatusTooManyRequests) || !statusFallbackAllowed(http.StatusBadGateway) {
		t.Fatal("expected 429 and 5xx to allow fallback")
	}
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusUnprocessableEntity} {
		if statusFallbackAllowed(status) {
			t.Fatalf("status %d must not fallback", status)
		}
	}
	if got := fallbackReasonForStatus(http.StatusTooManyRequests); got != "429" {
		t.Fatalf("429 reason = %q", got)
	}
	if got := fallbackReasonForError(context.DeadlineExceeded); got != "timeout" {
		t.Fatalf("deadline reason = %q", got)
	}
	if !contextOverflowBody([]byte(`{"error":{"code":"context_length_exceeded","message":"maximum context length"}}`)) {
		t.Fatal("expected context overflow body to be detected")
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

	listResp, err := http.Get(proxy.URL + "/admin/routing/decisions?limit=5")
	if err != nil {
		t.Fatal(err)
	}
	var listOut struct {
		Decisions []store.RoutingDecisionLog `json:"decisions"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listOut); err != nil {
		t.Fatal(err)
	}
	listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK || len(listOut.Decisions) != 1 || listOut.Decisions[0].ID != got.ID {
		t.Fatalf("routing decision list API mismatch status=%d out=%+v", listResp.StatusCode, listOut.Decisions)
	}
	detailResp, err := http.Get(proxy.URL + "/admin/routing/decisions/" + got.ID)
	if err != nil {
		t.Fatal(err)
	}
	var detailOut struct {
		Decision store.RoutingDecisionLog `json:"decision"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detailOut); err != nil {
		t.Fatal(err)
	}
	detailResp.Body.Close()
	if detailResp.StatusCode != http.StatusOK || detailOut.Decision.RequestID != got.RequestID || detailOut.Decision.DecisionReason == "" {
		t.Fatalf("routing decision detail API mismatch status=%d out=%+v", detailResp.StatusCode, detailOut.Decision)
	}
}

func TestAutoRouterRewritesWhenProviderPinnedAndIgnoresWildcardRule(t *testing.T) {
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
	if err := db.UpsertRoutingRule(context.Background(), store.RoutingRule{
		ID:            "rule_wildcard",
		Enabled:       true,
		Priority:      1,
		MatchPattern:  "*",
		MinComplexity: 0,
		MaxComplexity: 100,
		TargetModel:   "bad-rule-model",
	}); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	bodyBytes, _ := json.Marshal(map[string]any{
		"model": "vibe/auto",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", strings.NewReader(string(bodyBytes)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Proxy-Provider", "test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Routed-Model"); got != "gpt-4.1-mini" {
		t.Fatalf("expected auto to route to gpt-4.1-mini, got %q", got)
	}
	if seenModel != "gpt-4.1-mini" {
		t.Fatalf("upstream saw model %q", seenModel)
	}
}

func TestVibeAutoUsesAliasProviderPatternWhenSelectedModelHasNoPattern(t *testing.T) {
	defaultUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "default provider should not receive vibe/auto", http.StatusTeapot)
	}))
	defer defaultUpstream.Close()

	var seenModel string
	aliasUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var root map[string]any
		_ = json.Unmarshal(body, &root)
		seenModel, _ = root["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`))
	}))
	defer aliasUpstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(defaultUpstream.URL, "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	providerResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":           "alias-provider",
		"base_url":       aliasUpstream.URL,
		"api_key":        "alias-secret",
		"timeout_ms":     1000,
		"enabled":        true,
		"model_patterns": "vibe/*",
	})
	providerResp.Body.Close()
	if providerResp.StatusCode != http.StatusOK {
		t.Fatalf("provider create status %d", providerResp.StatusCode)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/auto",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected vibe/auto alias provider route to pass, got %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Routed-Model"); got != "gpt-4.1-mini" {
		t.Fatalf("expected X-Routed-Model=gpt-4.1-mini, got %q", got)
	}
	if seenModel != "gpt-4.1-mini" {
		t.Fatalf("alias provider saw model %q", seenModel)
	}

	waitFor(t, time.Second, func() bool {
		recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return len(recent) == 1 && recent[0].Provider == "alias-provider"
	})
	recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if len(recent) != 1 || recent[0].Provider != "alias-provider" || recent[0].Model != "gpt-4.1-mini" {
		t.Fatalf("unexpected audited route: %+v", recent)
	}
	decisions, err := db.ListRoutingDecisions(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) != 1 || decisions[0].RequestedModel != "vibe/auto" || decisions[0].SelectedModel != "gpt-4.1-mini" || decisions[0].SelectedProvider != "alias-provider" {
		t.Fatalf("unexpected routing decision: %+v", decisions)
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

	now := time.Now().UTC()
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{Request: store.RequestLog{
		ID: "health-fast", TraceID: "health-fast", Endpoint: "/v1/chat/completions",
		Model: "gpt-4.1-mini", Provider: "fast-provider", StatusCode: 200, LatencyMS: 80, CreatedAt: now.Add(-10 * time.Minute),
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{Request: store.RequestLog{
		ID: "health-bad", TraceID: "health-bad", Endpoint: "/v1/chat/completions",
		Model: "gpt-4.1", Provider: "degraded-provider", StatusCode: 504, LatencyMS: 3000, Error: "timeout", CreatedAt: now.Add(-5 * time.Minute),
	}}); err != nil {
		t.Fatal(err)
	}

	health, err := http.Get(proxy.URL + "/admin/routing/health?window=1h&threshold=90")
	if err != nil {
		t.Fatal(err)
	}
	defer health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("expected health status 200, got %d", health.StatusCode)
	}
	var healthOut struct {
		Threshold int                         `json:"threshold"`
		Providers []store.ProviderHealthScore `json:"providers"`
		Ranking   []struct {
			Provider string `json:"provider"`
			Rank     int    `json:"rank"`
		} `json:"ranking"`
		Degraded []store.ProviderHealthScore `json:"degraded"`
		Alerts   []struct {
			Provider string `json:"provider"`
			Code     string `json:"code"`
		} `json:"alerts"`
		Trend []struct {
			Providers []store.ProviderHealthScore `json:"providers"`
		} `json:"trend"`
	}
	if err := json.NewDecoder(health.Body).Decode(&healthOut); err != nil {
		t.Fatal(err)
	}
	if healthOut.Threshold != 90 || len(healthOut.Providers) == 0 || len(healthOut.Ranking) == 0 || len(healthOut.Trend) == 0 {
		t.Fatalf("unexpected health response: %+v", healthOut)
	}
	if healthOut.Ranking[0].Provider != "fast-provider" || healthOut.Ranking[0].Rank != 1 {
		t.Fatalf("expected fast provider first in ranking: %+v", healthOut.Ranking)
	}
	if len(healthOut.Degraded) == 0 || healthOut.Degraded[0].Provider != "degraded-provider" {
		t.Fatalf("expected degraded provider in health response: %+v", healthOut.Degraded)
	}
	hasTimeoutAlert := false
	for _, alert := range healthOut.Alerts {
		if alert.Provider == "degraded-provider" && alert.Code == "timeouts_detected" {
			hasTimeoutAlert = true
			break
		}
	}
	if !hasTimeoutAlert {
		t.Fatalf("expected timeout alert for degraded provider: %+v", healthOut.Alerts)
	}
}

func TestRoutingPreviewAppliesAPIKeyModelAndProviderPolicy(t *testing.T) {
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

	providerResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":           "allowed-provider",
		"base_url":       "http://allowed.invalid",
		"api_key":        "allowed-secret",
		"timeout_ms":     1000,
		"enabled":        true,
		"model_patterns": "gpt-4.1-mini",
	})
	providerResp.Body.Close()
	if providerResp.StatusCode != http.StatusOK {
		t.Fatalf("provider create status %d", providerResp.StatusCode)
	}
	if err := db.UpsertAPIKey(context.Background(), store.APIKeyRecord{
		ID:               "key_preview_policy",
		Name:             "preview-policy",
		KeyHash:          hashProxyKey("vc_sk_preview_policy"),
		Status:           "active",
		Scopes:           []string{"chat:completion", "routing:read"},
		AllowedModels:    []string{"gpt-4.1-mini"},
		AllowedProviders: []string{"allowed-provider"},
	}); err != nil {
		t.Fatal(err)
	}

	preview := postJSON(t, proxy.URL+"/admin/routing/preview", "", map[string]any{
		"api_key_id": "key_preview_policy",
		"model":      "vibe/auto",
		"messages": []any{
			map[string]any{"role": "user", "content": "Design a distributed architecture and compare consistency tradeoff."},
		},
	})
	defer preview.Body.Close()
	if preview.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(preview.Body)
		t.Fatalf("preview failed: %d %s", preview.StatusCode, body)
	}
	var out struct {
		PolicyAPIKeyID   string `json:"policy_api_key_id"`
		SelectedModel    string `json:"selected_model"`
		SelectedProvider string `json:"selected_provider"`
		DecisionReason   string `json:"decision_reason"`
	}
	if err := json.NewDecoder(preview.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.PolicyAPIKeyID != "key_preview_policy" || out.SelectedModel != "gpt-4.1-mini" || out.SelectedProvider != "allowed-provider" {
		t.Fatalf("preview did not apply key policy: %+v", out)
	}
	if !strings.Contains(out.DecisionReason, "auto alias mapped reasoning tier to gpt-4.1-mini") {
		t.Fatalf("expected policy-constrained auto reason, got %q", out.DecisionReason)
	}
}

func TestContextOverflowRetriesWithLongContextModel(t *testing.T) {
	seenModels := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var root map[string]any
		_ = json.NewDecoder(r.Body).Decode(&root)
		model, _ := root["model"].(string)
		seenModels = append(seenModels, model)
		w.Header().Set("Content-Type", "application/json")
		if model != "o3" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
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

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("tiny-context-model", false))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected long-context retry to pass, got %d: %s", resp.StatusCode, body)
	}
	if len(seenModels) != 2 || seenModels[0] != "tiny-context-model" || seenModels[1] != "o3" {
		t.Fatalf("expected retry with o3 after context overflow, saw %v", seenModels)
	}
	waitFor(t, time.Second, func() bool {
		recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return len(recent) == 1 && recent[0].Model == "o3"
	})
	decisions, err := db.ListRoutingDecisions(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) != 1 || decisions[0].SelectedModel != "o3" || !containsPrefix(decisions[0].FallbackPath, "context_overflow:tiny-context-model->o3") {
		t.Fatalf("expected context overflow routing decision, got %+v", decisions)
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

func containsPrefix(values []string, prefix string) bool {
	for _, value := range values {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}
