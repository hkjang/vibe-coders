package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// TestClickHouseIntegration runs the full DW path against a real ClickHouse. It is skipped
// unless CH_IT_URL is set (e.g. http://localhost:8124), so normal CI/offline runs are
// unaffected. CH_IT_USER/CH_IT_PASS/CH_IT_DB override credentials/database.
func TestClickHouseIntegration(t *testing.T) {
	url := os.Getenv("CH_IT_URL")
	if url == "" {
		t.Skip("CH_IT_URL not set; skipping real-ClickHouse integration test")
	}
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = strings.TrimRight(url, "/")
	cfg.ClickHouse.User = envOr("CH_IT_USER", "gw")
	cfg.ClickHouse.Password = envOr("CH_IT_PASS", "gwpass")
	cfg.ClickHouse.Database = envOr("CH_IT_DB", "ai_gateway")
	cfg.ClickHouse.Table = "analytics_daily"
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	cfg.ClickHouse.ToolFactTable = "ai_tool_fact"
	cfg.ClickHouse.RoutingFactTable = "ai_routing_fact"
	cfg.ClickHouse.EvalFactTable = "ai_eval_fact"
	cfg.ClickHouse.FeedbackFactTable = "ai_feedback_fact"
	cfg.ClickHouse.PolicyFactTable = "ai_policy_fact"
	cfg.ClickHouse.Text2SQLFactTable = "ai_text2sql_fact"
	cfg.ClickHouse.BatchSize = 1
	cfg.ClickHouse.FlushInterval = 300 * time.Millisecond

	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// 1) Bootstrap: every table + materialized view must be accepted by real ClickHouse.
	bResp, err := http.Post(srv.URL+"/admin/dw/clickhouse/bootstrap", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if bResp.StatusCode != http.StatusOK {
		body := readBody(bResp)
		t.Fatalf("bootstrap failed: %d %s", bResp.StatusCode, body)
	}
	bResp.Body.Close()

	now := time.Now().UTC()
	// 2) Request + tool + routing + eval facts (via the async queue).
	server.enqueue(store.LogRecord{
		Request: store.RequestLog{ID: "it-req-1", TraceID: "it-tr-1", Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
			Provider: "openai", Project: "payments", StatusCode: 200, ClientIP: "203.0.113.7", LatencyMS: 130, CreatedAt: now},
		Usage:       &store.TokenUsage{RequestID: "it-req-1", PromptTokens: 10, CompletionTokens: 20, TotalTokens: 30, EstimatedCost: 12.5, Currency: "KRW"},
		Tools:       []store.ToolInvocation{{RequestID: "it-req-1", TraceID: "it-tr-1", ServerLabel: "github", ToolName: "create_pr", Source: "call", IsMCP: true, CreatedAt: now}},
		Routing:     &store.RoutingDecisionLog{RequestID: "it-req-1", TraceID: "it-tr-1", RequestedModel: "auto", SelectedModel: "gpt-4.1", SelectedProvider: "openai", DecisionReason: "complexity", CreatedAt: now},
		Evaluations: []store.LLMEvaluation{{RequestID: "it-req-1", TraceID: "it-tr-1", Name: "injection", Category: "security", Score: 0.95, Label: "clean", Passed: true, CreatedAt: now}},
	})
	// 3) Feedback + policy facts (direct emit).
	server.emitFeedbackFact(store.LLMFeedback{RequestID: "it-req-1", TraceID: "it-tr-1", Rating: 1, Label: "good", Source: "admin", CreatedBy: "tester", CreatedAt: now})
	server.recordPolicyDecisionEvents(context.Background(), []store.PolicyDecisionEvent{
		{RequestID: "it-req-1", TeamID: "platform", Phase: "pre", PolicyID: "pol1", RuleID: "r1", RuleName: "allow-default", Decision: "allow", Reason: "ok", Model: "gpt-4.1", RiskScore: 10},
	})
	// 4) Text2SQL fact (watermark sink path) — insert a log then ship.
	_ = db.InsertText2SQLLog(context.Background(), store.Text2SQLQueryLog{
		ID: "it-t2s-1", RequestID: "it-req-1", Team: "platform", VirtualModel: "vibe/text2sql-preview", Mode: "preview",
		Question: "지난달 매출", GeneratedSQL: "SELECT sum(amount) FROM orders", Valid: true, Executed: false, CreatedAt: now,
	})
	if _, err := server.syncText2SQLFacts(context.Background()); err != nil {
		t.Fatalf("text2sql fact sink: %v", err)
	}

	// Verify each table received its row.
	count := func(table string) int64 {
		body, code, err := server.clickhouseQuery(context.Background(), server.chConf(),
			"SELECT count() FROM "+cfg.ClickHouse.Database+"."+table+" FORMAT TabSeparated")
		if err != nil || code != http.StatusOK {
			return -1
		}
		return parseInt64(strings.TrimSpace(body))
	}
	want := []string{"ai_request_fact", "ai_tool_fact", "ai_routing_fact", "ai_eval_fact", "ai_feedback_fact", "ai_policy_fact", "ai_text2sql_fact"}
	for _, table := range want {
		var got int64
		waitForNoFail(3*time.Second, func() bool { got = count(table); return got >= 1 })
		if got < 1 {
			t.Errorf("%s: expected >=1 row in ClickHouse, got %d", table, got)
		} else {
			t.Logf("%s: %d row(s)", table, got)
		}
	}

	// The daily materialized view should have aggregated the request fact.
	if mv := count("ai_request_fact_daily"); mv < 1 {
		t.Errorf("ai_request_fact_daily MV expected >=1 row, got %d", mv)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func waitForNoFail(d time.Duration, cond func() bool) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func readBody(resp *http.Response) string {
	defer resp.Body.Close()
	b := make([]byte, 4096)
	n, _ := resp.Body.Read(b)
	return string(b[:n])
}
