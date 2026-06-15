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

	// 3 today on expensive model (1 failing), 2 earlier this period on cheap model.
	rec("t0", "gpt-4.1", 200, 10, now.Add(-1*time.Hour))
	rec("t1", "gpt-4.1", 200, 10, now.Add(-2*time.Hour))
	rec("t2", "gpt-4.1", 500, 10, now.Add(-3*time.Hour))
	rec("e0", "gpt-4.1-mini", 200, 1, now.Add(-3*time.Hour))
	rec("e1", "gpt-4.1-mini", 200, 1, now.Add(-4*time.Hour))

	startToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
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
