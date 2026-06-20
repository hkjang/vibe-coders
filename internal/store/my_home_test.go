package store

import (
	"context"
	"testing"
	"time"
)

func TestMyHomeQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := db.db.ExecContext(ctx,
		`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id, team, role) VALUES (?,?,?,?,?,?,?,?)`,
		"k1", "key one", "hash-k1", "active", now.Format(time.RFC3339Nano), "u1", "platform", "developer"); err != nil {
		t.Fatal(err)
	}

	rec := func(id, model string, status int, cost float64, when time.Time) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k1", Endpoint: "/v1/chat/completions",
				Model: model, TaskType: "generate", StatusCode: status, CreatedAt: when},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Anchor records to fixed hours *today* (not now-relative offsets) so the test is
	// deterministic regardless of run time — now-relative offsets cross the UTC midnight
	// boundary when the suite runs in the first few hours of the day.
	startToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	// 3 today on expensive model (1 failing), 2 earlier this period on cheap model.
	rec("t0", "gpt-4.1", 200, 10, startToday.Add(3*time.Hour))
	rec("t1", "gpt-4.1", 200, 10, startToday.Add(2*time.Hour))
	rec("t2", "gpt-4.1", 500, 10, startToday.Add(1*time.Hour))
	rec("e0", "gpt-4.1-mini", 200, 1, startToday.Add(1*time.Hour))
	rec("e1", "gpt-4.1-mini", 200, 1, startToday.Add(30*time.Minute))
	today, err := db.UserUsageTotalsSince(ctx, "u1", startToday)
	if err != nil {
		t.Fatal(err)
	}
	if today.Requests != 5 || today.Errors != 1 {
		t.Errorf("today totals = %d reqs / %d errors, want 5 / 1", today.Requests, today.Errors)
	}
	if today.CostKRW < 31.9 || today.CostKRW > 32.1 {
		t.Errorf("today cost = %f, want ~32", today.CostKRW)
	}

	models, err := db.UserModelCosts(ctx, "u1", startToday)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].Model != "gpt-4.1" {
		t.Errorf("model costs = %+v, want gpt-4.1 busiest", models)
	}

	failures, err := db.UserRecentFailures(ctx, "u1", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(failures) != 1 || failures[0].StatusCode != 500 {
		t.Errorf("recent failures = %+v, want one 500", failures)
	}

	// Recommendations replace + list round-trip.
	recs := []PersonalRecommendation{
		{ID: "r1", Kind: "model_switch", Title: "use mini", EstSavingsKRW: 27},
		{ID: "r2", Kind: "template", Title: "use template"},
	}
	if err := db.ReplaceUserRecommendations(ctx, "u1", recs); err != nil {
		t.Fatal(err)
	}
	stored, err := db.ListUserRecommendations(ctx, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 || stored[0].EstSavingsKRW != 27 {
		t.Errorf("stored recs = %+v, want 2 with savings first", stored)
	}
	// Replacing again with one rec leaves exactly one.
	if err := db.ReplaceUserRecommendations(ctx, "u1", recs[:1]); err != nil {
		t.Fatal(err)
	}
	stored, _ = db.ListUserRecommendations(ctx, "u1")
	if len(stored) != 1 {
		t.Errorf("replace should overwrite, got %d recs", len(stored))
	}
}

func TestPersonalRecommendationCandidates(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	for _, row := range []struct {
		id, user string
	}{
		{"k1", "u1"},
		{"k2", "u2"},
	} {
		if _, err := db.db.ExecContext(ctx,
			`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id, team, role) VALUES (?,?,?,?,?,?,?,?)`,
			row.id, row.id, "hash-"+row.id, "active", now.Format(time.RFC3339Nano), row.user, "platform", "developer"); err != nil {
			t.Fatal(err)
		}
	}

	for i := 0; i < 3; i++ {
		if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{
			ID: "t2s_" + itoaStore(i), APIKeyID: "k1", Team: "platform",
			Question: "월별 매출 알려줘", GeneratedSQL: "select month, sum(amount) from sales group by month",
			SchemaName: "sales", Valid: true, Executed: true, CostKRW: 3, CreatedAt: now.Add(time.Duration(-i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{
		ID: "t2s_other", APIKeyID: "k2", Team: "platform",
		Question: "월별 매출 알려줘", GeneratedSQL: "select month, sum(amount) from sales group by month",
		SchemaName: "sales", Valid: true, CostKRW: 99, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	candidates, err := db.UserText2SQLReportCandidates(ctx, "u1", now.Add(-time.Hour), 3, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("expected 1 Text2SQL candidate, got %+v", candidates)
	}
	c := candidates[0]
	if c.Count != 3 || c.SchemaName != "sales" || c.RecommendedProduct != "dashboard" {
		t.Fatalf("unexpected Text2SQL candidate: %+v", c)
	}
	if c.Fingerprint == "" || c.Fingerprint[:6] != "t2sql_" {
		t.Fatalf("candidate should expose a fingerprint, got %+v", c)
	}
	if c.AvgCostKRW < 2.99 || c.AvgCostKRW > 3.01 || c.SuccessRate != 1 {
		t.Fatalf("candidate aggregates mismatch: %+v", c)
	}

	for i := 0; i < 3; i++ {
		id := "mcp_" + itoaStore(i)
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k1", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1-mini", TaskType: "planning", StatusCode: 200, LatencyMS: int64(100 + i), CreatedAt: now.Add(time.Duration(-i) * time.Minute)},
			Tools: []ToolInvocation{{
				ID: "tool_" + id, RequestID: id, TraceID: id, APIKeyID: "k1",
				ServerLabel: "jira", ToolName: "create_issue", Source: "call", IsMCP: true, CreatedAt: now.Add(time.Duration(-i) * time.Minute),
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	affinities, err := db.UserMCPAffinities(ctx, "u1", now.Add(-time.Hour), 2, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(affinities) != 1 {
		t.Fatalf("expected 1 MCP affinity, got %+v", affinities)
	}
	a := affinities[0]
	if a.Ref != "jira/create_issue" || a.Calls != 3 || a.SuccessRate != 1 {
		t.Fatalf("unexpected MCP affinity: %+v", a)
	}
}
