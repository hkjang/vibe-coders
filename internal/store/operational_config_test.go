package store

import (
	"context"
	"testing"
	"time"
)

func TestOperationalConfigAlertsBudgetsAndRoutingRules(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	flag, found, err := db.GetFlag(ctx, "maintenance")
	if err != nil || found || flag.Key != "maintenance" {
		t.Fatalf("missing flag mismatch found=%v flag=%+v err=%v", found, flag, err)
	}
	if err := db.SetFlag(ctx, RuntimeFlag{Key: "maintenance", Value: "off", UpdatedBy: "admin", Note: "initial"}); err != nil {
		t.Fatal(err)
	}
	flag, found, err = db.GetFlag(ctx, "maintenance")
	if err != nil || !found || flag.Value != "off" || flag.UpdatedBy != "admin" || flag.UpdatedAt.IsZero() {
		t.Fatalf("flag lookup mismatch found=%v flag=%+v err=%v", found, flag, err)
	}

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_config", Name: "config", Team: "platform", KeyHash: "hash_config", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "config_ok", apiKeyID: "key_config", sessionID: "config_sess", model: "gpt-4.1", provider: "openai",
		prompt: "normal prompt", language: "go", status: 200, latency: 100, firstChunk: 25, tokens: 100, cost: 10, when: now.Add(-30 * time.Minute),
		tools:       []ToolInvocation{{ID: "config_tool_ok", ToolName: "read_file", Source: "call"}},
		evaluations: []LLMEvaluation{{ID: "config_eval_ok", Name: "quality", Category: "eval", Evaluator: "fixture", Score: 0.9, Passed: true}},
	})
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "config_err", apiKeyID: "key_config", sessionID: "config_sess", model: "gpt-4.1", provider: "openai",
		prompt: "error prompt", language: "go", status: 500, latency: 1000, firstChunk: 200, tokens: 50, cost: 5, when: now.Add(-20 * time.Minute),
		tools:       []ToolInvocation{{ID: "config_tool_err", ToolName: "shell", Source: "call", IsError: true}},
		evaluations: []LLMEvaluation{{ID: "config_eval_err", Name: "quality", Category: "eval", Evaluator: "fixture", Score: 0.2, Passed: false}},
	})

	globalMetric, err := db.MetricSince(ctx, "global", "", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if globalMetric.Requests != 2 || globalMetric.Errors != 1 || globalMetric.Tokens != 150 || globalMetric.CostKRW != 15 || globalMetric.ToolCalls != 2 || globalMetric.ToolErrors != 1 || globalMetric.LLMEvaluations != 2 || globalMetric.LLMEvalFailures != 1 {
		t.Fatalf("global metric mismatch: %+v", globalMetric)
	}
	teamMetric, err := db.MetricSince(ctx, "team", "platform", now.Add(-time.Hour))
	if err != nil || teamMetric.Requests != 2 {
		t.Fatalf("team metric mismatch metric=%+v err=%v", teamMetric, err)
	}
	apiKeyMetric, err := db.MetricSince(ctx, "api_key", "key_config", now.Add(-time.Hour))
	if err != nil || apiKeyMetric.Requests != 2 {
		t.Fatalf("api key metric mismatch metric=%+v err=%v", apiKeyMetric, err)
	}
	ipMetric, err := db.MetricSince(ctx, "ip", "127.0.0.1", now.Add(-time.Hour))
	if err != nil || ipMetric.Requests != 2 {
		t.Fatalf("ip metric mismatch metric=%+v err=%v", ipMetric, err)
	}
	modelMetric, err := db.MetricSince(ctx, "model", "gpt-4.1", now.Add(-time.Hour))
	if err != nil || modelMetric.Requests != 2 {
		t.Fatalf("model metric mismatch metric=%+v err=%v", modelMetric, err)
	}
	if _, err := db.MetricSince(ctx, "bad", "", now.Add(-time.Hour)); err == nil {
		t.Fatal("unsupported metric scope should fail")
	}

	if err := db.UpsertAlertRule(ctx, AlertRule{ID: "alert_b", Name: "B Errors", Metric: "errors", WindowSeconds: 60, Threshold: 1, Scope: "global", Enabled: false, Note: "disabled"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAlertRule(ctx, AlertRule{ID: "alert_a", Name: "A Cost", Metric: "krw", WindowSeconds: 300, Threshold: 10, Scope: "team", ScopeValue: "platform", WebhookURL: "https://example.com/hook", Enabled: true, Note: "cost"}); err != nil {
		t.Fatal(err)
	}
	rules, err := db.ListAlertRules(ctx)
	if err != nil || len(rules) != 2 || rules[0].ID != "alert_a" || !rules[0].Enabled {
		t.Fatalf("alert rule list mismatch rules=%+v err=%v", rules, err)
	}
	firedAt := now.Add(-time.Minute)
	if err := db.UpdateAlertFireState(ctx, "alert_a", 42, firedAt); err != nil {
		t.Fatal(err)
	}
	rules, err = db.ListAlertRules(ctx)
	if err != nil || rules[0].LastFiredAt == nil || rules[0].LastValue != 42 {
		t.Fatalf("alert fire state mismatch rules=%+v err=%v", rules, err)
	}
	if err := db.InsertAlertEvent(ctx, AlertEvent{ID: "alert_event_1", RuleID: "alert_a", RuleName: "A Cost", Metric: "krw", Value: 42, Threshold: 10, Delivered: false, DeliveryError: "webhook failed"}); err != nil {
		t.Fatal(err)
	}
	events, err := db.ListAlertEvents(ctx, 0)
	if err != nil || len(events) != 1 || events[0].DeliveryError != "webhook failed" || events[0].CreatedAt.IsZero() {
		t.Fatalf("alert event mismatch events=%+v err=%v", events, err)
	}
	if err := db.DeleteAlertRule(ctx, "alert_b"); err != nil {
		t.Fatal(err)
	}
	rules, err = db.ListAlertRules(ctx)
	if err != nil || len(rules) != 1 {
		t.Fatalf("alert rule delete mismatch rules=%+v err=%v", rules, err)
	}

	if err := db.UpsertBudget(ctx, Budget{ID: "budget_key", Scope: "api_key", ScopeValue: "key_config", MonthlyKRW: 100, Note: "key budget"}); err != nil {
		t.Fatal(err)
	}
	budgets, err := db.ListBudgets(ctx)
	if err != nil || len(budgets) != 1 || budgets[0].ID != "budget_key" || budgets[0].CreatedAt.IsZero() {
		t.Fatalf("budget list mismatch budgets=%+v err=%v", budgets, err)
	}
	statuses, err := db.BudgetStatuses(ctx, now)
	if err != nil || len(statuses) != 1 || statuses[0].SpentKRW != 15 || statuses[0].ProjectedRatio <= 0 {
		t.Fatalf("budget status mismatch statuses=%+v err=%v", statuses, err)
	}
	maxRatio, err := db.MaxBudgetProjectedRatio(ctx, now)
	if err != nil || maxRatio <= 0 {
		t.Fatalf("max budget ratio mismatch ratio=%v err=%v", maxRatio, err)
	}
	monthStart, days := kstMonthBounds(now)
	if monthStart.In(budgetKST).Day() != 1 || days < 28 {
		t.Fatalf("kst month bounds mismatch start=%s days=%v", monthStart, days)
	}
	if err := db.DeleteBudget(ctx, "budget_key"); err != nil {
		t.Fatal(err)
	}
	budgets, err = db.ListBudgets(ctx)
	if err != nil || len(budgets) != 0 {
		t.Fatalf("budget delete mismatch budgets=%+v err=%v", budgets, err)
	}

	if err := db.UpsertRoutingRule(ctx, RoutingRule{ID: "route_b", Enabled: false, Priority: 20, MatchPattern: "*", TargetModel: "gpt-4.1-mini", Note: "disabled"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoutingRule(ctx, RoutingRule{ID: "route_a", Enabled: true, Priority: 10, MatchPattern: "vibe/auto", MinComplexity: 0, MaxComplexity: 59, TargetModel: "gpt-4.1", TargetProvider: "openai", Note: "auto"}); err != nil {
		t.Fatal(err)
	}
	routingRules, err := db.ListRoutingRules(ctx)
	if err != nil || len(routingRules) != 2 || routingRules[0].ID != "route_a" || routingRules[0].CreatedAt.IsZero() {
		t.Fatalf("routing rule list mismatch rules=%+v err=%v", routingRules, err)
	}
	activeRules, err := db.ActiveRoutingRules(ctx)
	if err != nil || len(activeRules) != 1 || activeRules[0].ID != "route_a" {
		t.Fatalf("active routing rules mismatch rules=%+v err=%v", activeRules, err)
	}
	if err := db.DeleteRoutingRule(ctx, "route_a"); err != nil {
		t.Fatal(err)
	}
	activeRules, err = db.ActiveRoutingRules(ctx)
	if err != nil || len(activeRules) != 0 {
		t.Fatalf("routing rule delete mismatch rules=%+v err=%v", activeRules, err)
	}
}
