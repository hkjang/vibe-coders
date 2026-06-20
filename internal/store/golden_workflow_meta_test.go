package store

import (
	"context"
	"testing"
)

func TestGoldenWorkflowStepMetadataRoundTrip(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	wf := GoldenWorkflow{
		ID:   "gwf1",
		Name: "regression",
		Steps: []GoldenWorkflowStep{{
			Name: "s1", Prompt: "summarize this", Expected: "summary",
			TaskType: "summary", SelectedModel: "claude-opus-4-8", BaselineScore: 87.5,
			ContractID: "pctr1", SourceRunID: "mmt-9",
		}},
		Tags: []string{"multimodel"},
	}
	if err := db.UpsertGoldenWorkflow(ctx, wf); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetGoldenWorkflow(ctx, "gwf1")
	if err != nil || len(got.Steps) != 1 {
		t.Fatalf("get workflow: steps=%d err=%v", len(got.Steps), err)
	}
	s := got.Steps[0]
	if s.SelectedModel != "claude-opus-4-8" || s.BaselineScore != 87.5 || s.TaskType != "summary" || s.SourceRunID != "mmt-9" {
		t.Fatalf("step metadata not round-tripped: %+v", s)
	}

	// Appending another step (promotion to an existing workflow) preserves order + metadata.
	got.Steps = append(got.Steps, GoldenWorkflowStep{Name: "s2", Prompt: "p2", SelectedModel: "m2", BaselineScore: 70})
	if err := db.UpsertGoldenWorkflow(ctx, got); err != nil {
		t.Fatal(err)
	}
	got2, _ := db.GetGoldenWorkflow(ctx, "gwf1")
	if len(got2.Steps) != 2 || got2.Steps[1].SelectedModel != "m2" {
		t.Fatalf("append step failed: %+v", got2.Steps)
	}
}
