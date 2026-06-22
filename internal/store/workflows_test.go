package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestWorkflowRoundtripAndRuns(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "wf.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	wf := Workflow{
		ID: "wf1", Name: "리뷰 체인", Enabled: true, AllowedTeams: "alpha",
		Steps: []WorkflowStep{
			{Name: "리뷰", Type: "skill", Ref: "code-review", MaxCostKRW: 100, AllowedTools: []string{"shell"}},
			{Name: "승인", Type: "approval"},
		},
	}
	if err := db.UpsertWorkflow(ctx, wf); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetWorkflow(ctx, "wf1")
	if err != nil || !found {
		t.Fatalf("get: found=%v err=%v", found, err)
	}
	if len(got.Steps) != 2 || got.Steps[0].Type != "skill" || got.Steps[0].Ref != "code-review" {
		t.Fatalf("steps not preserved: %+v", got.Steps)
	}
	if len(got.Steps[0].AllowedTools) != 1 || got.Steps[0].AllowedTools[0] != "shell" {
		t.Fatalf("step limits not preserved: %+v", got.Steps[0])
	}

	if err := db.RecordWorkflowRun(ctx, WorkflowRun{ID: "run1", WorkflowID: "wf1", UserID: "alice", StepsTotal: 2, StepsOK: 2}); err != nil {
		t.Fatal(err)
	}
	runs, err := db.ListWorkflowRuns(ctx, "alice", "", 10)
	if err != nil || len(runs) != 1 || runs[0].Status != "planned" {
		t.Fatalf("runs: %+v err=%v", runs, err)
	}
	if other, _ := db.ListWorkflowRuns(ctx, "bob", "", 10); len(other) != 0 {
		t.Fatalf("bob should have no runs, got %d", len(other))
	}

	gotRun, found, err := db.GetWorkflowRun(ctx, "run1")
	if err != nil || !found || gotRun.WorkflowID != "wf1" || gotRun.StepsOK != 2 {
		t.Fatalf("GetWorkflowRun(run1) = %+v found=%v err=%v", gotRun, found, err)
	}
	if _, found, _ := db.GetWorkflowRun(ctx, "nope"); found {
		t.Fatal("unknown workflow run should not be found")
	}

	// Publish snapshots the definition and bumps the version.
	v1, err := db.PublishWorkflowVersion(ctx, got, "admin@x", "first")
	if err != nil || v1 != 1 {
		t.Fatalf("publish v1 = %d err=%v", v1, err)
	}
	v2, _ := db.PublishWorkflowVersion(ctx, got, "admin@x", "second")
	if v2 != 2 {
		t.Fatalf("publish v2 = %d, want 2", v2)
	}
	versions, err := db.ListWorkflowVersions(ctx, "wf1")
	if err != nil || len(versions) != 2 || versions[0].Version != 2 {
		t.Fatalf("versions = %+v err=%v", versions, err)
	}
	if len(versions[1].Steps) != 2 || versions[1].Steps[0].Ref != "code-review" {
		t.Fatalf("v1 snapshot lost steps: %+v", versions[1].Steps)
	}
	if versions[1].PublishedBy != "admin@x" || versions[1].Note != "first" {
		t.Fatalf("v1 metadata wrong: %+v", versions[1])
	}
}
