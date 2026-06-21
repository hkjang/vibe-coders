package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

var workflowStepTypes = map[string]bool{
	"chat": true, "text2sql": true, "mcp_tool": true, "skill": true,
	"condition": true, "approval": true, "transform": true,
}

// handleAdminWorkflows manages workflow definitions (admin).
// GET    /admin/workflows            list
// POST   /admin/workflows            upsert
// DELETE /admin/workflows?id=..       delete
func (s *Server) handleAdminWorkflows(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		wfs, err := s.db.ListWorkflows(ctx)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"workflows": wfs})
	case http.MethodPost:
		var p struct {
			ID           string               `json:"id"`
			Name         string               `json:"name"`
			Description  string               `json:"description"`
			Steps        []store.WorkflowStep `json:"steps"`
			AllowedTeams string               `json:"allowed_teams"`
			Enabled      *bool                `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.Name) == "" || len(p.Steps) == 0 {
			writeOpenAIError(w, http.StatusBadRequest, "name and at least one step are required", "invalid_request_error", "missing_fields")
			return
		}
		for i, st := range p.Steps {
			if !workflowStepTypes[strings.TrimSpace(st.Type)] {
				writeOpenAIError(w, http.StatusBadRequest, "invalid step type at index "+itoaProxy(i)+": "+st.Type, "invalid_request_error", "bad_step_type")
				return
			}
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		wf := store.Workflow{
			ID: firstNonEmpty(strings.TrimSpace(p.ID), newID("wf")), Name: strings.TrimSpace(p.Name),
			Description: p.Description, Steps: p.Steps, AllowedTeams: strings.TrimSpace(p.AllowedTeams),
			Enabled: enabled, CreatedBy: adminID(r),
		}
		if err := s.db.UpsertWorkflow(ctx, wf); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "upsert_failed")
			return
		}
		s.auditAdmin(r, "workflow_upsert", "", auditJSON(map[string]any{"id": wf.ID, "name": wf.Name, "steps": len(wf.Steps)}))
		writeJSON(w, http.StatusOK, map[string]any{"id": wf.ID, "ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param required", "invalid_request_error", "no_id")
			return
		}
		if err := s.db.DeleteWorkflow(ctx, id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "workflow_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminWorkflowDryRun validates a workflow's steps and returns a per-step plan + issues,
// without executing anything. POST /admin/workflows/{id}/dry-run
func (s *Server) handleAdminWorkflowDryRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/admin/workflows/"), "/dry-run")
	wf, found, err := s.db.GetWorkflow(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "workflow not found", "invalid_request_error", "not_found")
		return
	}
	plan, issues := s.planWorkflow(r, wf)
	writeJSON(w, http.StatusOK, map[string]any{
		"workflow_id": wf.ID, "name": wf.Name, "steps": plan, "issues": issues, "ok": len(issues) == 0,
		"note": "dry-run: 단계 검증과 안전 한도만 확인하며 실제 실행은 하지 않습니다.",
	})
}

// planWorkflow validates each step and returns the plan + a list of issues.
func (s *Server) planWorkflow(r *http.Request, wf store.Workflow) ([]map[string]any, []string) {
	plan := make([]map[string]any, 0, len(wf.Steps))
	issues := []string{}
	for i, st := range wf.Steps {
		resolved, detail := true, ""
		switch st.Type {
		case "skill":
			if st.Ref != "" {
				if _, found, _ := s.db.GetSkill(r.Context(), st.Ref); !found {
					resolved, detail = false, "skill not found: "+st.Ref
				}
			}
		case "chat", "text2sql", "mcp_tool", "condition", "approval", "transform":
			// control/runtime steps: structurally valid
		default:
			resolved, detail = false, "unknown step type: "+st.Type
		}
		if !resolved {
			issues = append(issues, "step "+itoaProxy(i)+" ("+firstNonEmpty(st.Name, st.Type)+"): "+detail)
		}
		plan = append(plan, map[string]any{
			"name": st.Name, "type": st.Type, "ref": st.Ref, "resolved": resolved, "detail": detail,
			"limits": map[string]any{"timeout_ms": st.TimeoutMS, "max_cost_krw": st.MaxCostKRW, "max_tokens": st.MaxTokens,
				"allowed_tools": st.AllowedTools, "allowed_tables": st.AllowedTables},
		})
	}
	return plan, issues
}

// handleV1WorkflowRun re-validates and records a workflow run for the caller, returning the plan.
// (Server-side step execution is a follow-up; this validates permissions and records the run.)
// POST /v1/workflows/{id}/run
func (s *Server) handleV1WorkflowRun(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/v1/workflows/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" || (action != "run" && action != "") {
		writeOpenAIError(w, http.StatusBadRequest, "expected POST /v1/workflows/{id}/run", "invalid_request_error", "bad_request")
		return
	}
	wf, found, err := s.db.GetWorkflow(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found || !wf.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "workflow not found", "invalid_request_error", "not_found")
		return
	}
	// Team gating: empty allowed_teams = any team.
	if teams := splitCSV(wf.AllowedTeams); len(teams) > 0 && !containsFold(teams, claims.TeamID) {
		writeOpenAIError(w, http.StatusForbidden, "workflow not allowed for your team", "invalid_request_error", "forbidden")
		return
	}
	if action == "" {
		writeJSON(w, http.StatusOK, map[string]any{"workflow": wf})
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var runReq struct {
		Execute bool   `json:"execute"`
		Input   string `json:"input"`
	}
	_ = json.NewDecoder(r.Body).Decode(&runReq)

	// Execute mode: run the steps server-side, chaining each step's output to the next.
	if runReq.Execute {
		s.executeWorkflowRun(w, r, wf, runReq.Input, claims)
		return
	}

	start := time.Now()
	plan, issues := s.planWorkflow(r, wf)
	errClass := ""
	if len(issues) > 0 {
		errClass = "step_unresolved"
	}
	runID := newID("wfrun")
	_ = s.db.RecordWorkflowRun(r.Context(), store.WorkflowRun{
		ID: runID, WorkflowID: wf.ID, UserID: claims.Subject, Team: claims.TeamID, Status: "planned",
		StepsTotal: len(wf.Steps), StepsOK: len(wf.Steps) - len(issues), LatencyMS: time.Since(start).Milliseconds(), ErrorClass: errClass,
	})
	s.auditAuthEvent(r.Context(), "workflow_run", claims.Subject, "", claims.TeamID, "workflow="+wf.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "workflow_id": wf.ID, "name": wf.Name, "status": "planned", "steps": plan, "issues": issues,
		"note": "각 step을 순서대로 호출해 실행하세요. 실행 이력은 /me/workflow-runs에서 확인할 수 있습니다.",
	})
}

// executeWorkflowRun runs a workflow's steps sequentially, chaining each step's output into the
// next step's input. chat/skill/text2sql steps run through the real /v1 pipeline (governance,
// quota, policy all apply); approval pauses; condition can stop; transform passes through;
// mcp_tool is skipped (not yet executable). Live step outputs are returned to the caller; only
// aggregate metadata is persisted.
func (s *Server) executeWorkflowRun(w http.ResponseWriter, r *http.Request, wf store.Workflow, input string, claims accessClaims) {
	start := time.Now()
	results := make([]map[string]any, 0, len(wf.Steps))
	cur := input
	status := "ok"
	stepsOK := 0
	errClass := ""

	for i, st := range wf.Steps {
		stepRes := map[string]any{"name": firstNonEmpty(st.Name, st.Type), "type": st.Type}
		// Per-step timeout.
		stepReq := r
		if st.TimeoutMS > 0 {
			ctx, cancel := context.WithTimeout(r.Context(), time.Duration(st.TimeoutMS)*time.Millisecond)
			defer cancel()
			stepReq = r.Clone(ctx)
		}
		var out string
		var err error
		switch st.Type {
		case "approval":
			status = "pending_approval"
			stepRes["status"] = "pending_approval"
			results = append(results, stepRes)
			s.notifyMattermost(r.Context(), "approval", "워크플로 승인 대기: "+wf.Name+" step "+itoaProxy(i)+" (사용자 "+claims.Subject+")")
			s.finishWorkflowRun(w, r, wf, claims, results, status, stepsOK, errClass, start)
			return
		case "condition":
			if strings.TrimSpace(cur) == "" {
				status, errClass = "condition_failed", "condition_failed"
				stepRes["status"] = "stopped"
				results = append(results, stepRes)
				s.finishWorkflowRun(w, r, wf, claims, results, status, stepsOK, errClass, start)
				return
			}
			stepRes["status"] = "passed"
			stepsOK++
			results = append(results, stepRes)
			continue
		case "transform":
			// Pass-through transform (no model call). Keeps the chain moving.
			stepRes["status"] = "ok"
			stepsOK++
			results = append(results, stepRes)
			continue
		case "mcp_tool":
			stepRes["status"] = "skipped"
			stepRes["detail"] = "mcp_tool 실행은 후속 예정"
			results = append(results, stepRes)
			continue
		case "chat":
			out, err = s.workflowChatStep(stepReq, firstNonEmpty(st.Ref, "vibe/auto"), cur, st.MaxTokens, nil)
		case "skill":
			out, err = s.workflowChatStep(stepReq, "vibe/auto", cur, st.MaxTokens, map[string]string{"X-Skill": st.Ref})
		case "text2sql":
			out, err = s.workflowChatStep(stepReq, "vibe/text2sql-preview", cur, 0, nil)
		default:
			err = errGateway("unknown step type: " + st.Type)
		}
		if err != nil {
			status, errClass = "error", "step_error"
			stepRes["status"] = "error"
			stepRes["error"] = err.Error()
			results = append(results, stepRes)
			s.finishWorkflowRun(w, r, wf, claims, results, status, stepsOK, errClass, start)
			return
		}
		cur = out
		stepsOK++
		stepRes["status"] = "ok"
		stepRes["output"] = out
		results = append(results, stepRes)
	}
	s.finishWorkflowRun(w, r, wf, claims, results, status, stepsOK, errClass, start)
}

// workflowChatStep runs one step through the /v1 chat pipeline and returns the text output.
func (s *Server) workflowChatStep(r *http.Request, model, prompt string, maxTokens int64, headers map[string]string) (string, error) {
	if strings.TrimSpace(prompt) == "" {
		return "", errGateway("step input is empty")
	}
	msg, _ := json.Marshal(map[string]string{"role": "user", "content": prompt})
	body := map[string]any{"model": model, "messages": []json.RawMessage{msg}, "stream": false}
	if maxTokens > 0 {
		body["max_tokens"] = maxTokens
	}
	return s.runGatewayChat(r, body, headers)
}

// finishWorkflowRun persists aggregate run metadata and writes the response.
func (s *Server) finishWorkflowRun(w http.ResponseWriter, r *http.Request, wf store.Workflow, claims accessClaims, results []map[string]any, status string, stepsOK int, errClass string, start time.Time) {
	runID := newID("wfrun")
	_ = s.db.RecordWorkflowRun(r.Context(), store.WorkflowRun{
		ID: runID, WorkflowID: wf.ID, UserID: claims.Subject, Team: claims.TeamID, Status: status,
		StepsTotal: len(wf.Steps), StepsOK: stepsOK, LatencyMS: time.Since(start).Milliseconds(), ErrorClass: errClass,
	})
	s.auditAuthEvent(r.Context(), "workflow_execute", claims.Subject, "", claims.TeamID, "workflow="+wf.ID+" status="+status)
	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "workflow_id": wf.ID, "name": wf.Name, "status": status,
		"steps_total": len(wf.Steps), "steps_ok": stepsOK, "results": results,
		"note": "서버측 순차 실행 결과입니다. step 출력은 호출자에게만 반환되며 저장은 집계 메타데이터만 남습니다.",
	})
}

// handleMyWorkflowRuns lists the caller's own workflow run history. GET /me/workflow-runs
func (s *Server) handleMyWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	runs, err := s.db.ListWorkflowRuns(r.Context(), userID, strings.TrimSpace(r.URL.Query().Get("workflow_id")), intQuery(r, "limit", 50))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}
