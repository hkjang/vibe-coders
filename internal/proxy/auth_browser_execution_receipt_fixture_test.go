//go:build linux

package proxy

import (
	"testing"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Only safe metadata is seeded. The browser still uses the real session and
// receipt handlers, including their per-execution ownership checks.
func seedBrowserExecutionReceipts(t *testing.T, db *store.SQLStore) {
	t.Helper()
	ctx := t.Context()
	if err := db.UpsertWorkflow(ctx, store.Workflow{ID: "browser-receipt-workflow", Name: "영수증 검증 업무", Steps: []store.WorkflowStep{}}); err != nil {
		t.Fatal("receipt workflow fixture failed")
	}
	if err := db.CreateWorkApp(ctx, store.WorkApp{ID: "browser-receipt-app", Title: "영수증 검증 앱", Components: []store.AppComponent{}}); err != nil {
		t.Fatal("receipt app fixture failed")
	}
	for _, actor := range []struct{ suffix, user string }{{"owner", "browser-local-admin"}, {"other", "browser-local-readonly"}} {
		workflowRun := "browser-workflow-receipt-" + actor.suffix
		if err := db.RecordWorkflowRun(ctx, store.WorkflowRun{ID: workflowRun, WorkflowID: "browser-receipt-workflow", UserID: actor.user, Team: "browser-team", Status: "pending_approval", StepsTotal: 4, StepsOK: 2, LatencyMS: 1250}); err != nil {
			t.Fatal("workflow receipt fixture failed")
		}
		if err := db.RecordWorkflowStepRuns(ctx, workflowRun, []store.WorkflowStepRun{
			{StepIndex: 0, Name: "입력 정리", Type: "transform", Status: "ok"},
			{StepIndex: 1, Name: "조건 확인", Type: "condition", Status: "passed"},
			{StepIndex: 2, Name: "도구 단계", Type: "mcp_tool", Status: "skipped"},
			{StepIndex: 3, Name: "승인 확인", Type: "approval", Status: "pending_approval"},
		}); err != nil {
			t.Fatal("workflow receipt steps fixture failed")
		}
		if err := db.RecordAIAppRun(ctx, store.AIAppRun{ID: "browser-app-receipt-" + actor.suffix, AppID: "browser-receipt-app", UserID: actor.user, Team: "browser-team", Status: "planned", InputHash: audit.HashText("isolated-receipt-input-never-displayed"), OutputSummary: "2 components planned", LatencyMS: 12}); err != nil {
			t.Fatal("app receipt fixture failed")
		}
	}
}
