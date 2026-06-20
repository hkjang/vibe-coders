package store

import (
	"context"
	"testing"
)

func TestMultiModelJudgementRows(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Two runs for team-a, one for team-b.
	for _, r := range []MultiModelTestRun{
		{ID: "r1", Team: "team-a", ModelCount: 2},
		{ID: "r2", Team: "team-a", ModelCount: 2},
		{ID: "r3", Team: "team-b", ModelCount: 1},
	} {
		if err := db.SaveMultiModelRun(ctx, r, nil); err != nil {
			t.Fatal(err)
		}
	}
	js := []MultiModelTestJudgement{
		{ID: "j1", RunID: "r1", Model: "A", TotalScore: 90, Verdict: "pass"},
		{ID: "j2", RunID: "r1", Model: "B", TotalScore: 70, Verdict: "warn"},
		{ID: "j3", RunID: "r2", Model: "A", TotalScore: 60, Verdict: "warn"},
		{ID: "j4", RunID: "r3", Model: "C", TotalScore: 95, Verdict: "pass"},
	}
	if err := db.ReplaceMultiModelJudgements(ctx, "r1", js[:2]); err != nil {
		t.Fatal(err)
	}
	if err := db.ReplaceMultiModelJudgements(ctx, "r2", js[2:3]); err != nil {
		t.Fatal(err)
	}
	if err := db.ReplaceMultiModelJudgements(ctx, "r3", js[3:]); err != nil {
		t.Fatal(err)
	}

	// Team filter restricts to team-a's runs (3 judgement rows).
	rows, err := db.MultiModelJudgementRows(ctx, "team-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("team-a rows = %d, want 3", len(rows))
	}
	for _, r := range rows {
		if r.Team != "team-a" {
			t.Errorf("unexpected team %q in filtered rows", r.Team)
		}
	}
	// No filter returns all 4.
	all, _ := db.MultiModelJudgementRows(ctx, "", "")
	if len(all) != 4 {
		t.Fatalf("all rows = %d, want 4", len(all))
	}
}
