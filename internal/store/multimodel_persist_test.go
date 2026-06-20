package store

import (
	"context"
	"testing"
)

func TestMultiModelRunPersistence(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	run := MultiModelTestRun{ID: "mmt1", Title: "비교", CreatedBy: "u1", Team: "team_platform",
		PromptHash: "h1", ModelCount: 2, Success: 1, Failed: 1}
	results := []MultiModelTestResult{
		{RunID: "mmt1", Model: "gpt-4.1-mini", Provider: "openai", Status: "success", LatencyMS: 2400, InputTokens: 800, OutputTokens: 1200, CostKRW: 120, ResponsePreview: "ok", ResponseHash: "rh1"},
		{RunID: "mmt1", Model: "local-qwen", Provider: "local", Status: "error", Error: "timeout", LatencyMS: 30000},
	}
	if err := db.SaveMultiModelRun(ctx, run, results); err != nil {
		t.Fatal(err)
	}

	list, err := db.ListMultiModelRuns(ctx, 10)
	if err != nil || len(list) != 1 || list[0].ID != "mmt1" || list[0].Success != 1 {
		t.Fatalf("list = %+v err=%v", list, err)
	}

	gotRun, gotResults, fb, found, err := db.GetMultiModelRun(ctx, "mmt1")
	if err != nil || !found {
		t.Fatalf("get found=%v err=%v", found, err)
	}
	if gotRun.ModelCount != 2 || len(gotResults) != 2 || len(fb) != 0 {
		t.Fatalf("detail mismatch: run=%+v results=%d fb=%d", gotRun, len(gotResults), len(fb))
	}
	// Results ordered by latency asc → gpt first.
	if gotResults[0].Model != "gpt-4.1-mini" {
		t.Fatalf("expected gpt first (lowest latency), got %s", gotResults[0].Model)
	}

	// Feedback round-trip.
	if err := db.InsertMultiModelFeedback(ctx, MultiModelTestFeedback{ID: "fb1", RunID: "mmt1", Model: "gpt-4.1-mini", Rating: 5, Comment: "best"}); err != nil {
		t.Fatal(err)
	}
	_, _, fb2, _, _ := db.GetMultiModelRun(ctx, "mmt1")
	if len(fb2) != 1 || fb2[0].Rating != 5 || fb2[0].Model != "gpt-4.1-mini" {
		t.Fatalf("feedback = %+v", fb2)
	}

	// Missing run.
	if _, _, _, found, _ := db.GetMultiModelRun(ctx, "nope"); found {
		t.Fatal("missing run should not be found")
	}
}

func TestMultiModelPromotion(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	if err := db.InsertMultiModelPromotion(ctx, MultiModelTestPromotion{ID: "p1", RunID: "mmt1", SelectedModel: "claude-sonnet", TaskType: "code_review", Reason: "best"}); err != nil {
		t.Fatal(err)
	}
	got, err := db.ListMultiModelPromotions(ctx, "mmt1")
	if err != nil || len(got) != 1 || got[0].SelectedModel != "claude-sonnet" || got[0].Status != "draft" {
		t.Fatalf("promotions = %+v err=%v (want draft claude-sonnet)", got, err)
	}
	if other, _ := db.ListMultiModelPromotions(ctx, "nope"); len(other) != 0 {
		t.Fatalf("unrelated run should have no promotions, got %d", len(other))
	}
}
