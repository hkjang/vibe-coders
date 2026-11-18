package proxy

import (
	"context"
	"net/http/httptest"
	"reflect"
	"testing"

	"vibe-coders/internal/store"
)

func runtimeBranchFixture() store.Workflow {
	// The entry is deliberately not the first definition and one branch runs
	// backward in array order. A linear runner or receipt indexed by result
	// position would execute or identify the wrong steps.
	return store.Workflow{ID: "branch", Steps: []store.WorkflowStep{
		{ID: "yes", Type: "transform", Ref: "yes-ref"},
		{ID: "merge", Type: "transform", Ref: "merge-ref"},
		{ID: "start", Type: "condition", Condition: &store.WorkflowCondition{Operator: "non_empty"}},
		{ID: "no", Type: "transform", Ref: "no-ref"},
	}, Flow: &store.WorkflowFlow{Version: 1, Entry: "start", Edges: []store.WorkflowEdge{
		{From: "start", To: "yes", When: "true"}, {From: "start", To: "no", When: "false"},
		{From: "yes", To: "merge", When: "next"}, {From: "no", To: "merge", When: "next"},
		{From: "merge", To: store.WorkflowGraphEnd, When: "next"},
	}}}
}

func TestWorkflowGraphRuntimeBranchesAndReceipts(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "workflow-graph-fixture")
	wf := runtimeBranchFixture()
	for _, tt := range []struct {
		input, branch string
		path          []string
		refs          []string
	}{
		{"한글 입력", "true", []string{"start", "yes", "merge"}, []string{"", "yes-ref", "merge-ref"}},
		{" \n", "false", []string{"start", "no", "merge"}, []string{"", "no-ref", "merge-ref"}},
	} {
		t.Run(tt.branch, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/v1/workflows/branch/run", nil)
			results, status, count, errClass := s.executeWorkflowSteps(r, wf, tt.input, accessClaims{})
			if status != "ok" || count != 3 || errClass != "" || len(results) != 3 {
				t.Fatalf("execution: %s %d %s %+v", status, count, errClass, results)
			}
			path := []string{}
			for _, res := range results {
				id, _ := res["step_id"].(string)
				path = append(path, id)
			}
			if !reflect.DeepEqual(path, tt.path) || results[0]["branch"] != tt.branch {
				t.Fatalf("selected path = %+v", results)
			}
			s.recordWorkflowStepRuns(r, "run-"+tt.branch, wf, results)
			stored, err := db.ListWorkflowStepRuns(t.Context(), "run-"+tt.branch)
			if err != nil || len(stored) != 3 {
				t.Fatalf("receipt: %+v %v", stored, err)
			}
			for i, st := range stored {
				if st.StepIndex != i || st.StepID != tt.path[i] || st.Ref != tt.refs[i] || st.DefinitionIndex == nil || wf.Steps[*st.DefinitionIndex].ID != st.StepID {
					t.Fatalf("wrong executed step receipt: %+v", st)
				}
			}
			if stored[0].Branch != tt.branch {
				t.Fatal("condition decision missing")
			}
		})
	}
}

func TestWorkflowGraphRuntimeRejectsBeforeSideEffects(t *testing.T) {
	s := &Server{} // A model/MCP side effect would panic without gateway dependencies.
	wf := runtimeBranchFixture()
	wf.Steps[2].Type = "chat"
	r := httptest.NewRequest("POST", "/v1/workflows/branch/run", nil)
	results, status, count, errClass := s.executeWorkflowSteps(r, wf, "input", accessClaims{})
	if len(results) != 0 || status != "error" || count != 0 || errClass != "invalid_workflow_graph" {
		t.Fatalf("invalid graph ran: %+v %s %d %s", results, status, count, errClass)
	}
	wf = runtimeBranchFixture()
	ctx, cancel := context.WithCancel(r.Context())
	cancel()
	results, status, count, errClass = s.executeWorkflowSteps(r.WithContext(ctx), wf, "input", accessClaims{})
	if len(results) != 0 || status != "error" || count != 0 || errClass != "cancelled" {
		t.Fatal("cancelled graph ran")
	}
}

func TestWorkflowGraphRuntimeKeepsLegacySequence(t *testing.T) {
	s := &Server{}
	wf := store.Workflow{Steps: []store.WorkflowStep{{Type: "condition"}, {Type: "transform"}, {Type: "mcp_tool"}}}
	r := httptest.NewRequest("POST", "/v1/workflows/legacy/run", nil)
	results, status, count, errClass := s.executeWorkflowSteps(r, wf, "", accessClaims{})
	if len(results) != 1 || status != "condition_failed" || count != 0 || errClass != "condition_failed" {
		t.Fatal("legacy empty condition changed")
	}
	results, status, count, errClass = s.executeWorkflowSteps(r, wf, "text", accessClaims{})
	if len(results) != 3 || status != "ok" || count != 2 || errClass != "" || results[2]["status"] != "skipped" {
		t.Fatal("legacy sequence changed")
	}
	if _, exists := results[0]["step_id"]; exists {
		t.Fatal("legacy result unexpectedly changed shape")
	}
}
