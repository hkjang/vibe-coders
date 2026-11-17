package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func testBranchWorkflow() Workflow {
	return Workflow{ID: "graph-test", Name: "입력 분기", Steps: []WorkflowStep{
		{ID: "start", Type: "condition", Condition: &WorkflowCondition{Operator: "non_empty"}},
		{ID: "yes", Type: "transform"}, {ID: "no", Type: "transform"}, {ID: "merge", Type: "transform"},
	}, Flow: &WorkflowFlow{Version: 1, Entry: "start", Edges: []WorkflowEdge{
		{From: "start", To: "yes", When: "true"}, {From: "start", To: "no", When: "false"},
		{From: "yes", To: "merge", When: "next"}, {From: "no", To: "merge", When: "next"},
		{From: "merge", To: WorkflowGraphEnd, When: "next"},
	}}}
}

func TestWorkflowGraphValidation(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Workflow)
	}{
		{"unknown version", func(w *Workflow) { w.Flow.Version = 2 }},
		{"missing entry", func(w *Workflow) { w.Flow.Entry = "absent" }},
		{"duplicate ID", func(w *Workflow) { w.Steps[1].ID = "start" }},
		{"invalid ID", func(w *Workflow) { w.Steps[1].ID = "../yes" }},
		{"missing flow", func(w *Workflow) { w.Flow = nil }},
		{"missing condition", func(w *Workflow) { w.Steps[0].Condition = nil }},
		{"script predicate", func(w *Workflow) { w.Steps[0].Condition.Operator = "eval" }},
		{"empty contains", func(w *Workflow) { w.Steps[0].Condition.Operator = "contains" }},
		{"wrong predicate type", func(w *Workflow) { w.Steps[0].Type = "transform" }},
		{"missing source", func(w *Workflow) { w.Flow.Edges[0].From = "absent" }},
		{"missing target", func(w *Workflow) { w.Flow.Edges[0].To = "absent" }},
		{"missing false", func(w *Workflow) { w.Flow.Edges = append(w.Flow.Edges[:1], w.Flow.Edges[2:]...) }},
		{"duplicate edge", func(w *Workflow) { w.Flow.Edges = append(w.Flow.Edges, w.Flow.Edges[0]) }},
		{"wrong edge label", func(w *Workflow) { w.Flow.Edges[0].When = "next" }},
		{"cycle", func(w *Workflow) { w.Flow.Edges[4].To = "start" }},
		{"unreachable", func(w *Workflow) { w.Flow.Edges[1].To = "yes" }},
		{"not resumable", func(w *Workflow) { w.Steps[1].Type = "approval" }},
		{"unenforced cost", func(w *Workflow) { w.Steps[1].MaxCostKRW = 1 }},
		{"unenforced table", func(w *Workflow) { w.Steps[1].AllowedTables = []string{"customers"} }},
		{"unenforced tool", func(w *Workflow) { w.Steps[1].AllowedTools = []string{"shell"} }},
		{"negative timeout", func(w *Workflow) { w.Steps[1].TimeoutMS = -1 }},
		{"timeout overflow", func(w *Workflow) { w.Steps[1].TimeoutMS = 9223372036854775807 }},
		{"unenforced tokens", func(w *Workflow) { w.Steps[1].MaxTokens = 1 }},
	}
	if err := ValidateWorkflowGraph(testBranchWorkflow()); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wf := testBranchWorkflow()
			tt.edit(&wf)
			if err := ValidateWorkflowGraph(wf); !errors.Is(err, ErrInvalidWorkflowGraph) {
				t.Fatalf("expected invalid graph, got %v", err)
			}
		})
	}
}

func TestWorkflowGraphLegacyCompatibility(t *testing.T) {
	wf := Workflow{Steps: []WorkflowStep{{Type: "condition"}, {Type: "mcp_tool", MaxCostKRW: 10}}}
	if err := ValidateWorkflowGraph(wf); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		op, value, input string
		want             bool
	}{
		{"non_empty", "", " \n\t", false}, {"non_empty", "", "한글", true},
		{"equals", "예", "예", true}, {"equals", "예", " 예 ", false},
		{"contains", "승인", "승인 필요", true}, {"contains", "YES", "yes", false},
	} {
		if got := (WorkflowCondition{Operator: tt.op, Value: tt.value}).Matches(tt.input); got != tt.want {
			t.Fatalf("%+v = %v", tt, got)
		}
	}
}

func TestWorkflowGraphPersistence(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	wf := testBranchWorkflow()
	if err := db.UpsertWorkflow(ctx, wf); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetWorkflow(ctx, wf.ID)
	if err != nil || !found || !reflect.DeepEqual(got.Flow, wf.Flow) || !reflect.DeepEqual(got.Steps, wf.Steps) {
		t.Fatalf("roundtrip failed: %+v %v", got, err)
	}
	if _, err := db.PublishWorkflowVersion(ctx, got, "operator", "분기 버전"); err != nil {
		t.Fatal(err)
	}
	versions, err := db.ListWorkflowVersions(ctx, wf.ID)
	if err != nil || len(versions) != 1 || !reflect.DeepEqual(versions[0].Flow, wf.Flow) {
		t.Fatalf("snapshot: %+v %v", versions, err)
	}
	// A legacy editor cannot silently discard a graph it does not understand.
	legacy := Workflow{ID: wf.ID, Name: "overwrite", Steps: []WorkflowStep{{Type: "chat"}}}
	if err := db.UpsertWorkflow(ctx, legacy); !errors.Is(err, ErrWorkflowGraphEditRequired) {
		t.Fatalf("legacy overwrite: %v", err)
	}
	after, _, _ := db.GetWorkflow(ctx, wf.ID)
	if !reflect.DeepEqual(after.Flow, wf.Flow) || after.Name != wf.Name {
		t.Fatal("legacy overwrite changed graph")
	}
	index := 2
	if err := db.RecordWorkflowStepRuns(ctx, "branch-run", []WorkflowStepRun{{StepIndex: 1, DefinitionIndex: &index, StepID: "no", Branch: "false", Ref: "actual-ref", Status: "passed"}}); err != nil {
		t.Fatal(err)
	}
	runs, err := db.ListWorkflowStepRuns(ctx, "branch-run")
	if err != nil || len(runs) != 1 || runs[0].StepID != "no" || runs[0].DefinitionIndex == nil || *runs[0].DefinitionIndex != 2 || runs[0].Branch != "false" {
		t.Fatalf("receipt: %+v %v", runs, err)
	}
}

func TestWorkflowGraphUpgradePreservesLegacyRecords(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	legacy := Workflow{ID: "upgrade", Name: "이전 순차 정의", Steps: []WorkflowStep{{Name: "전달", Type: "transform"}}, Enabled: false}
	if err := db.UpsertWorkflow(t.Context(), legacy); err != nil {
		t.Fatal(err)
	}
	legacy, _, _ = db.GetWorkflow(t.Context(), legacy.ID)
	if _, err := db.PublishWorkflowVersion(t.Context(), legacy, "operator", "이전 버전"); err != nil {
		t.Fatal(err)
	}
	legacy, _, _ = db.GetWorkflow(t.Context(), legacy.ID)
	if err := db.RecordWorkflowStepRuns(t.Context(), "old-run", []WorkflowStepRun{{Name: "전달", Type: "transform", Status: "ok"}}); err != nil {
		t.Fatal(err)
	}
	// Reconstruct the immediately preceding schema, keeping real stored rows.
	for _, change := range []struct{ table, column string }{{"workflows", "flow"}, {"workflow_versions", "flow"}, {"workflow_step_runs", "step_id"}, {"workflow_step_runs", "definition_index"}, {"workflow_step_runs", "branch"}} {
		if _, err := db.db.ExecContext(t.Context(), "ALTER TABLE "+change.table+" DROP COLUMN "+change.column); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := db.Migrate(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	current, found, err := db.GetWorkflow(t.Context(), legacy.ID)
	if err != nil || !found || !reflect.DeepEqual(current, legacy) {
		t.Fatalf("legacy migration %+v %v", current, err)
	}
	versions, err := db.ListWorkflowVersions(t.Context(), legacy.ID)
	if err != nil || len(versions) != 1 || versions[0].Flow != nil || versions[0].Name != legacy.Name {
		t.Fatal("legacy version changed")
	}
	steps, err := db.ListWorkflowStepRuns(t.Context(), "old-run")
	if err != nil || len(steps) != 1 || steps[0].StepID != "" || steps[0].DefinitionIndex != nil || steps[0].Branch != "" {
		t.Fatal("old receipt gained graph metadata")
	}
	graph := testBranchWorkflow()
	graph.ID = legacy.ID
	revision, _ := WorkflowRevision(current)
	saved, err := db.CommitWorkflowGraph(t.Context(), graph, revision, workflowGraphAudit("upgrade-graph"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	current, _, err = db.GetWorkflow(t.Context(), legacy.ID)
	if err != nil || !reflect.DeepEqual(current, saved) {
		t.Fatal("restart migration changed graph")
	}
}
