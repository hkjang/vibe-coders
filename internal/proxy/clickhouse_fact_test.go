package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestClickHouseRequestFactSink(t *testing.T) {
	var mu sync.Mutex
	bodies := []string{}
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			bodies = append(bodies, string(b))
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	cfg.ClickHouse.BatchSize = 1 // flush immediately on enqueue
	cfg.ClickHouse.FlushInterval = 200 * time.Millisecond
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	server.enqueue(store.LogRecord{
		Request: store.RequestLog{
			ID: "req-fact-1", TraceID: "tr1", Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
			Provider: "openai", StatusCode: 200, ClientIP: "203.0.113.9", LatencyMS: 120, CreatedAt: time.Now().UTC(),
		},
		Usage: &store.TokenUsage{RequestID: "req-fact-1", PromptTokens: 5, CompletionTokens: 7, TotalTokens: 12, EstimatedCost: 9.5, Currency: "KRW"},
	})

	var got string
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, b := range bodies {
			if strings.Contains(b, "req-fact-1") {
				got = b
				return true
			}
		}
		return false
	})

	if !strings.Contains(got, `"model":"gpt-4.1"`) {
		t.Errorf("fact row missing model: %s", got)
	}
	if !strings.Contains(got, `"client_ip_hash"`) {
		t.Errorf("fact row missing client_ip_hash: %s", got)
	}
	if strings.Contains(got, "203.0.113.9") {
		t.Errorf("raw client IP must not be shipped, got: %s", got)
	}
	if !strings.Contains(got, `"total_tokens":12`) {
		t.Errorf("fact row missing token usage: %s", got)
	}
}

func TestClickHouseFactFanout(t *testing.T) {
	var mu sync.Mutex
	byTable := map[string]string{} // table -> last body
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		if strings.Contains(q, "INSERT INTO") {
			// query looks like: INSERT INTO db.table FORMAT JSONEachRow
			fields := strings.Fields(q)
			table := ""
			if len(fields) >= 3 {
				table = fields[2]
				if i := strings.IndexByte(table, '.'); i >= 0 {
					table = table[i+1:]
				}
			}
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			byTable[table] = string(b)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	cfg.ClickHouse.ToolFactTable = "ai_tool_fact"
	cfg.ClickHouse.RoutingFactTable = "ai_routing_fact"
	cfg.ClickHouse.EvalFactTable = "ai_eval_fact"
	cfg.ClickHouse.BatchSize = 1
	cfg.ClickHouse.FlushInterval = 200 * time.Millisecond
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	server.enqueue(store.LogRecord{
		Request:     store.RequestLog{ID: "rq1", TraceID: "tr1", Model: "gpt-4.1", Provider: "openai", StatusCode: 200, CreatedAt: now},
		Tools:       []store.ToolInvocation{{RequestID: "rq1", TraceID: "tr1", ServerLabel: "github", ToolName: "create_pr", Source: "call", IsMCP: true, CreatedAt: now}},
		Routing:     &store.RoutingDecisionLog{RequestID: "rq1", TraceID: "tr1", RequestedModel: "auto", SelectedModel: "gpt-4.1", SelectedProvider: "openai", DecisionReason: "complexity", CreatedAt: now},
		Evaluations: []store.LLMEvaluation{{RequestID: "rq1", TraceID: "tr1", Name: "injection", Category: "security", Score: 0.9, Label: "clean", Passed: true, CreatedAt: now}},
	})

	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return byTable["ai_request_fact"] != "" && byTable["ai_tool_fact"] != "" &&
			byTable["ai_routing_fact"] != "" && byTable["ai_eval_fact"] != ""
	})

	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(byTable["ai_tool_fact"], `"tool_name":"create_pr"`) {
		t.Errorf("tool fact wrong: %s", byTable["ai_tool_fact"])
	}
	if !strings.Contains(byTable["ai_routing_fact"], `"selected_model":"gpt-4.1"`) {
		t.Errorf("routing fact wrong: %s", byTable["ai_routing_fact"])
	}
	if !strings.Contains(byTable["ai_eval_fact"], `"name":"injection"`) {
		t.Errorf("eval fact wrong: %s", byTable["ai_eval_fact"])
	}
}

func TestClickHouseText2SQLFactExpanded(t *testing.T) {
	var mu sync.Mutex
	var body string
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			body = string(b)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	cfg := config.ClickHouseConfig{URL: ch.URL, Database: "ai_gateway", Text2SQLFactTable: "ai_text2sql_fact"}
	logs := []store.Text2SQLQueryLog{{
		RequestID: "t2s1", Team: "platform", VirtualModel: "vibe/text2sql-preview", Mode: "preview",
		Question: "지난달 매출", GeneratedSQL: "SELECT sum(amount) FROM orders", Valid: false,
		RejectReason: "missing_date_filter", FailureCategory: "validation", CreatedAt: time.Now().UTC(),
	}}
	n, err := clickhouseText2SQLFactSink(context.Background(), http.DefaultClient, cfg, logs)
	if err != nil || n != 1 {
		t.Fatalf("fact sink = %d, %v", n, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(body, `"reject_reason":"missing_date_filter"`) {
		t.Errorf("expected reject_reason in fact: %s", body)
	}
	if !strings.Contains(body, `"sql_hash":`) || strings.Contains(body, "SELECT sum(amount)") {
		t.Errorf("expected sql_hash and no raw SQL: %s", body)
	}
}

func TestClickHouseLagAndEvents(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		switch {
		case strings.Contains(q, "count()"):
			_, _ = w.Write([]byte("5\n"))
		case strings.Contains(q, "FORMAT JSON"):
			_, _ = w.Write([]byte(`{"data":[{"request_id":"x"}],"rows":1}`))
		default:
			_, _ = w.Write([]byte("1\n"))
		}
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.Table = "analytics_daily"
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	lr, _ := http.Get(srv.URL + "/admin/dw/clickhouse/lag")
	var lag map[string]any
	json.NewDecoder(lr.Body).Decode(&lag)
	lr.Body.Close()
	if lag["request_fact_rows"] != float64(5) {
		t.Fatalf("expected request_fact_rows=5, got %v", lag["request_fact_rows"])
	}
	if tbls, _ := lag["tables"].([]any); len(tbls) < 2 {
		t.Fatalf("expected rollup + request_fact in tables, got %v", lag["tables"])
	}

	ev, _ := http.Get(srv.URL + "/admin/dw/clickhouse/events?table=ai_request_fact&limit=10")
	var events map[string]any
	json.NewDecoder(ev.Body).Decode(&events)
	ev.Body.Close()
	if _, ok := events["data"]; !ok {
		t.Fatalf("expected events data, got %v", events)
	}

	// A non-configured table is rejected.
	bad, _ := http.Get(srv.URL + "/admin/dw/clickhouse/events?table=secret_table")
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-configured table should 400, got %d", bad.StatusCode)
	}
	bad.Body.Close()
}

func TestClickHouseFeedbackFact(t *testing.T) {
	var mu sync.Mutex
	var body string
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			body = string(b)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.FeedbackFactTable = "ai_feedback_fact"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	server.emitFeedbackFact(store.LLMFeedback{
		RequestID: "rq9", TraceID: "tr9", Rating: -1, Label: "wrong", Source: "admin", CreatedBy: "alice", CreatedAt: time.Now().UTC(),
	})
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(body, "rq9")
	})
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(body, `"label":"wrong"`) || !strings.Contains(body, `"created_by":"alice"`) {
		t.Errorf("feedback fact wrong: %s", body)
	}
}

func TestClickHouseSkillFact(t *testing.T) {
	var mu sync.Mutex
	var body string
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			body = string(b)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "sk.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.SkillFactTable = "ai_skill_fact"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	server.emitSkillFact(store.SkillRun{
		SkillName: "concise", SkillVersion: "1.0.0", Actor: "svc-key", Model: "gpt-4o",
		Status: "ok", ToolsUsed: "search", CostKRW: 12.5, LatencyMS: 88,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(body, "concise")
	})
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(body, `"status":"ok"`) || !strings.Contains(body, `"actor":"svc-key"`) {
		t.Errorf("skill fact wrong: %s", body)
	}

	// Unconfigured → no-op (must not panic / insert).
	cfg2 := testConfig("http://upstream.invalid", "secret")
	srv2, _ := NewServer(cfg2, db, logger, nil)
	srv2.emitSkillFact(store.SkillRun{SkillName: "x", Status: "ok"})
}

func TestClickHousePolicyFact(t *testing.T) {
	var mu sync.Mutex
	var body string
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			body = string(b)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.PolicyFactTable = "ai_policy_fact"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	server.recordPolicyDecisionEvents(context.Background(), []store.PolicyDecisionEvent{
		{RequestID: "rqp", TeamID: "platform", Phase: "pre", PolicyID: "pol1", RuleID: "r1", RuleName: "block-secrets", Decision: "block", Reason: "secret detected", Model: "gpt-4.1", RiskScore: 90},
	})
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(body, "rqp")
	})
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(body, `"decision":"block"`) || !strings.Contains(body, `"rule_name":"block-secrets"`) {
		t.Errorf("policy fact wrong: %s", body)
	}
}

func TestClickHouseRequestFactDisabledNoQueue(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	// No RequestFactTable → enqueue is a safe no-op (no panic, nothing dropped meaningfully).
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.enqueue(store.LogRecord{Request: store.RequestLog{ID: "x", CreatedAt: time.Now().UTC()}})
}
