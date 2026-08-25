package store

import (
	"context"
	"testing"
	"time"
)

func TestModelMigrationAdvice(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, fp, model string, status int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: model, TaskType: "generate", PromptFingerprint: fp, StatusCode: status, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Cluster "fp_gen": dominant expensive model (gpt-4.1, 6 reqs @ 10, all success) +
	// a cheaper adequate alternative (gpt-4.1-mini, 4 reqs @ 1, all success).
	for i := 0; i < 6; i++ {
		rec("a"+itoaStore(i), "fp_gen", "gpt-4.1", 200, 10)
	}
	for i := 0; i < 4; i++ {
		rec("b"+itoaStore(i), "fp_gen", "gpt-4.1-mini", 200, 1)
	}

	advice, err := db.ModelMigrationAdvice(ctx, now.Add(-time.Hour), 100, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(advice) != 1 {
		t.Fatalf("expected 1 recommendation, got %d (%+v)", len(advice), advice)
	}
	a := advice[0]
	if a.CurrentModel != "gpt-4.1" || a.RecommendedModel != "gpt-4.1-mini" {
		t.Errorf("recommendation = %s→%s, want gpt-4.1→gpt-4.1-mini", a.CurrentModel, a.RecommendedModel)
	}
	if a.Requests != 10 {
		t.Errorf("cluster requests = %d, want 10", a.Requests)
	}
	// Savings = (10 - 1) avg cost * 10 requests = 90.
	if a.EstimatedSavingsKRW < 89.9 || a.EstimatedSavingsKRW > 90.1 {
		t.Errorf("estimated savings = %f, want ~90", a.EstimatedSavingsKRW)
	}

	// A cluster with only one model yields no advice, and one below min_requests is skipped.
	rec("s0", "fp_solo", "gpt-4.1", 200, 10)
	rec("s1", "fp_solo", "gpt-4.1", 200, 10)
	advice2, err := db.ModelMigrationAdvice(ctx, now.Add(-time.Hour), 100, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(advice2) != 1 {
		t.Errorf("single-model / below-threshold clusters should not add advice, got %d", len(advice2))
	}
}
