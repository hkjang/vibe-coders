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

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestComplexityScoreMonotonic(t *testing.T) {
	small := complexityScore([]store.PromptLog{{RedactedText: "hi"}}, 0)
	big := complexityScore([]store.PromptLog{
		{RedactedText: string(make([]byte, 20000))},
		{RedactedText: string(make([]byte, 20000))},
	}, 12)
	if small >= big {
		t.Fatalf("expected larger prompt+tools to score higher: small=%d big=%d", small, big)
	}
	if big > 100 || small < 0 {
		t.Fatalf("score out of range: small=%d big=%d", small, big)
	}
}

func TestExplainRoutingFallbackCacheSafetyCost(t *testing.T) {
	// alpha-dead drops the connection; zeta-alive answers → failover.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		conn, _, _ := hj.Hijack()
		conn.Close()
	}))
	defer dead.Close()
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"prompt_tokens_details":{"cached_tokens":800}}}`))
	}))
	defer alive.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(dead.URL, "dead-secret")
	cfg.Pricing = map[string]config.ModelPrice{
		"foo": {InputKRWPer1M: 1_000_000, OutputKRWPer1M: 2_000_000, CachedInputKRWPer1M: 100_000},
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, p := range []map[string]any{
		{"name": "alpha-dead", "base_url": dead.URL, "api_key": "x", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
		{"name": "zeta-alive", "base_url": alive.URL, "api_key": "y", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
	} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", p)
		resp.Body.Close()
	}

	out := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("foo-1", false))
	if out.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(out.Body)
		t.Fatalf("expected 200, got %d: %s", out.StatusCode, body)
	}
	out.Body.Close()

	waitFor(t, 2*time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 1
	})
	recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if len(recent) == 0 {
		t.Fatal("no request recorded")
	}
	id := recent[0].ID

	resp, err := http.Get(proxy.URL + "/admin/requests/" + id + "/explain")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var x struct {
		Routing  map[string]any `json:"routing"`
		Fallback map[string]any `json:"fallback"`
		Cache    map[string]any `json:"cache"`
		Cost     map[string]any `json:"cost"`
		Safety   map[string]any `json:"safety"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&x); err != nil {
		t.Fatal(err)
	}
	// routing: model_pattern auto-route to alpha-dead (first match)
	if x.Routing["reason"] != "model_pattern" {
		t.Errorf("expected model_pattern routing, got %v", x.Routing["reason"])
	}
	if _, ok := x.Routing["complexity"]; !ok {
		t.Error("expected complexity in routing")
	}
	// fallback occurred from alpha-dead to zeta-alive
	if x.Fallback["occurred"] != true {
		t.Errorf("expected fallback occurred, got %v", x.Fallback)
	}
	if x.Fallback["from_provider"] != "alpha-dead" {
		t.Errorf("expected from_provider alpha-dead, got %v", x.Fallback["from_provider"])
	}
	// cache: 800 cached tokens → cached savings > 0
	if cs, ok := x.Cache["cached_savings_krw"].(float64); !ok || cs <= 0 {
		t.Errorf("expected positive cached_savings_krw, got %v", x.Cache["cached_savings_krw"])
	}
	// cost: priced true, list >= actual
	if x.Cost["priced"] != true {
		t.Errorf("expected priced cost")
	}
}

func TestExplain404ForUnknownRequest(t *testing.T) {
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
	resp, err := http.Get(proxy.URL + "/admin/requests/nope/explain")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestExplainAndDetailIncludeGovernanceEvents(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called for blocked secret")
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

	pol := postJSON(t, proxy.URL+"/admin/policies", "", map[string]any{
		"name": "secret block",
		"rules": []any{
			map[string]any{"contains_secret": true, "block": true},
		},
	})
	pol.Body.Close()
	if pol.StatusCode != http.StatusCreated {
		t.Fatalf("policy status %d", pol.StatusCode)
	}

	blocked := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "gpt-4.1",
		"messages": []any{
			map[string]any{"role": "user", "content": "use api_key=sk-1234567890abcdefghijklmnopqrstuv"},
		},
	})
	blocked.Body.Close()
	if blocked.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", blocked.StatusCode)
	}

	waitFor(t, 2*time.Second, func() bool {
		recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return len(recent) == 1 && recent[0].StatusCode == http.StatusForbidden
	})
	recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	id := recent[0].ID

	detailResp, err := http.Get(proxy.URL + "/admin/requests/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	var detail store.RequestDetail
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Governance.SecretEvents) == 0 {
		t.Fatalf("expected secret events in request detail, got %+v", detail.Governance)
	}
	if len(detail.Governance.PolicyDecisions) == 0 || detail.Governance.PolicyDecisions[0].Decision != "block" {
		t.Fatalf("expected policy decisions in request detail, got %+v", detail.Governance)
	}

	explainResp, err := http.Get(proxy.URL + "/admin/requests/" + id + "/explain")
	if err != nil {
		t.Fatal(err)
	}
	defer explainResp.Body.Close()
	var explain struct {
		Safety     map[string]any `json:"safety"`
		Governance struct {
			SecretEventCount    float64                     `json:"secret_event_count"`
			SecretEvents        []store.SecretEvent         `json:"secret_events"`
			PolicyDecisionCount float64                     `json:"policy_decision_count"`
			PolicyDecisions     []store.PolicyDecisionEvent `json:"policy_decisions"`
		} `json:"governance"`
	}
	if err := json.NewDecoder(explainResp.Body).Decode(&explain); err != nil {
		t.Fatal(err)
	}
	if explain.Safety["blocked"] != true {
		t.Fatalf("expected safety blocked, got %+v", explain.Safety)
	}
	if explain.Governance.SecretEventCount == 0 || len(explain.Governance.SecretEvents) == 0 {
		t.Fatalf("expected governance secret events, got %+v", explain.Governance)
	}
	if explain.Governance.PolicyDecisionCount == 0 || len(explain.Governance.PolicyDecisions) == 0 {
		t.Fatalf("expected governance policy decisions, got %+v", explain.Governance)
	}
}
