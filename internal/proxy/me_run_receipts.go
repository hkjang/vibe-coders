package proxy

import (
	"net/http"
	"strings"
)

// handleAppRunReceipt returns a safe receipt for one of the caller's AI app runs (no raw
// input/output — aggregate metadata only). GET /v1/app-runs/{run_id}/receipt
func (s *Server) handleAppRunReceipt(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	runID, ok := runReceiptID(r.URL.Path, "/v1/app-runs/")
	if !ok {
		writeOpenAIError(w, http.StatusBadRequest, "expected GET /v1/app-runs/{run_id}/receipt", "invalid_request_error", "bad_request")
		return
	}
	run, found, err := s.db.GetAIAppRun(r.Context(), runID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "run not found", "invalid_request_error", "not_found")
		return
	}
	if run.UserID != userID {
		writeOpenAIError(w, http.StatusForbidden, "this run does not belong to you", "invalid_request_error", "forbidden")
		return
	}
	title := ""
	if app, ok, _ := s.db.GetWorkApp(r.Context(), run.AppID); ok {
		title = app.Title
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": run.ID, "kind": "app", "app_id": run.AppID, "app_title": title,
		"status": run.Status, "error_class": run.ErrorClass, "output_summary": run.OutputSummary,
		"input_hash": run.InputHash, "latency_ms": run.LatencyMS, "cost_krw": run.CostKRW, "created_at": run.CreatedAt,
		"note": "AI 업무 앱 실행 영수증입니다. 원문 입력/출력은 포함되지 않습니다.",
	})
}

// handleWorkflowRunReceipt returns a safe receipt for one of the caller's workflow runs.
// GET /v1/workflow-runs/{run_id}/receipt
func (s *Server) handleWorkflowRunReceipt(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	runID, ok := runReceiptID(r.URL.Path, "/v1/workflow-runs/")
	if !ok {
		writeOpenAIError(w, http.StatusBadRequest, "expected GET /v1/workflow-runs/{run_id}/receipt", "invalid_request_error", "bad_request")
		return
	}
	run, found, err := s.db.GetWorkflowRun(r.Context(), runID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "run not found", "invalid_request_error", "not_found")
		return
	}
	if run.UserID != userID {
		writeOpenAIError(w, http.StatusForbidden, "this run does not belong to you", "invalid_request_error", "forbidden")
		return
	}
	name := ""
	if wf, ok, _ := s.db.GetWorkflow(r.Context(), run.WorkflowID); ok {
		name = wf.Name
	}
	// Per-step breakdown (safe metadata only — no raw output).
	steps := []map[string]any{}
	if stepRuns, err := s.db.ListWorkflowStepRuns(r.Context(), run.ID); err == nil {
		for _, st := range stepRuns {
			steps = append(steps, map[string]any{
				"step_index": st.StepIndex, "name": st.Name, "type": st.Type, "ref": st.Ref,
				"status": st.Status, "output_chars": st.OutputChars, "error_class": st.ErrorClass,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": run.ID, "kind": "workflow", "workflow_id": run.WorkflowID, "workflow_name": name,
		"status": run.Status, "error_class": run.ErrorClass, "steps_total": run.StepsTotal, "steps_ok": run.StepsOK,
		"latency_ms": run.LatencyMS, "cost_krw": run.CostKRW, "created_at": run.CreatedAt, "steps": steps,
		"note": "워크플로 실행 영수증입니다. step별 상태/출력 길이만 표시하며 원문 prompt/SQL/tool args는 포함되지 않습니다.",
	})
}

// runReceiptID extracts {run_id} from "{prefix}{run_id}/receipt".
func runReceiptID(path, prefix string) (string, bool) {
	rest := strings.TrimPrefix(path, prefix)
	idx := strings.LastIndex(rest, "/")
	if idx < 0 || rest[idx+1:] != "receipt" {
		return "", false
	}
	id := rest[:idx]
	if id == "" {
		return "", false
	}
	return id, true
}
