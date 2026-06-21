package proxy

import (
	"net/http/httptest"
	"testing"

	"vibe-coders/internal/store"
)

func TestPlanWorkflowControlSteps(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest("POST", "/admin/workflows/wf/dry-run", nil)
	wf := store.Workflow{
		ID: "wf", Name: "chain",
		Steps: []store.WorkflowStep{
			{Name: "ask", Type: "chat"},
			{Name: "check", Type: "condition"},
			{Name: "ok", Type: "approval"},
			{Name: "fold", Type: "transform"},
			{Name: "bad", Type: "frobnicate"}, // unknown → issue
		},
	}
	plan, issues := s.planWorkflow(req, wf)
	if len(plan) != 5 {
		t.Fatalf("plan length = %d, want 5", len(plan))
	}
	if len(issues) != 1 {
		t.Fatalf("expected 1 issue (unknown step), got %d: %v", len(issues), issues)
	}
	// chat/condition/approval/transform must all resolve.
	for i := 0; i < 4; i++ {
		if plan[i]["resolved"] != true {
			t.Errorf("step %d (%v) should resolve", i, plan[i]["type"])
		}
	}
	if plan[4]["resolved"] != false {
		t.Error("unknown step must not resolve")
	}
	// Limits are echoed in the plan.
	if _, ok := plan[0]["limits"]; !ok {
		t.Error("plan step missing limits")
	}
}
