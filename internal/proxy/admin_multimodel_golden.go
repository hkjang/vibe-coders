package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleMultiRunGolden promotes a selected model's result from a multi-model run into a Golden
// Workflow step, for model-change regression. Appends to an existing workflow (workflow_id) or
// creates a new one (workflow_name). Captures task_type, selected_model, baseline_score,
// contract, and rubric on the step. POST /admin/chat-test/multi-run/runs/{id}/golden
func (s *Server) handleMultiRunGolden(w http.ResponseWriter, r *http.Request, runID string) {
	var p struct {
		WorkflowID    string `json:"workflow_id"`
		WorkflowName  string `json:"workflow_name"`
		StepName      string `json:"step_name"`
		SelectedModel string `json:"selected_model"`
		TaskType      string `json:"task_type"`
		ContractID    string `json:"contract_id"`
		RubricID      string `json:"rubric_id"`
		Prompt        string `json:"prompt"`   // fallback when the run did not store the prompt
		Expected      string `json:"expected"` // optional expected marker for the golden check
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
		return
	}
	p.SelectedModel = strings.TrimSpace(p.SelectedModel)
	if p.SelectedModel == "" {
		writeOpenAIError(w, http.StatusBadRequest, "selected_model is required", "invalid_request_error", "missing_model")
		return
	}
	if strings.TrimSpace(p.WorkflowID) == "" && strings.TrimSpace(p.WorkflowName) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "workflow_id or workflow_name is required", "invalid_request_error", "missing_workflow")
		return
	}

	run, results, _, found, err := s.db.GetMultiModelRun(r.Context(), runID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "multi_run_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "run not found", "invalid_request_error", "not_found")
		return
	}
	// Locate the selected model's result.
	var sel *store.MultiModelTestResult
	for i := range results {
		if results[i].Model == p.SelectedModel {
			sel = &results[i]
			break
		}
	}
	if sel == nil {
		writeOpenAIError(w, http.StatusBadRequest, "selected_model not present in this run", "invalid_request_error", "bad_model")
		return
	}

	prompt := strings.TrimSpace(p.Prompt)
	if prompt == "" {
		prompt = run.PromptPreview
	}
	if prompt == "" {
		writeOpenAIError(w, http.StatusBadRequest, "원문이 저장되지 않은 run입니다 — prompt를 함께 전달하세요", "invalid_request_error", "missing_prompt")
		return
	}
	expected := strings.TrimSpace(p.Expected)

	// Baseline score from the selected model's stored judgement (if a judge pass ran).
	baseline := 0.0
	if js, err := s.db.ListMultiModelJudgements(r.Context(), runID); err == nil {
		for _, j := range js {
			if j.Model == p.SelectedModel {
				baseline = j.TotalScore
				break
			}
		}
	}

	stepName := strings.TrimSpace(p.StepName)
	if stepName == "" {
		stepName = "step-" + p.SelectedModel
	}
	step := store.GoldenWorkflowStep{
		Name: stepName, Prompt: prompt, Expected: expected,
		TaskType: strings.TrimSpace(p.TaskType), SelectedModel: p.SelectedModel,
		BaselineScore: baseline, ContractID: strings.TrimSpace(p.ContractID), RubricID: strings.TrimSpace(p.RubricID),
		SourceRunID: runID,
	}

	var wf store.GoldenWorkflow
	if id := strings.TrimSpace(p.WorkflowID); id != "" {
		existing, gerr := s.db.GetGoldenWorkflow(r.Context(), id)
		if gerr != nil || existing.ID == "" {
			writeOpenAIError(w, http.StatusNotFound, "workflow not found", "invalid_request_error", "not_found")
			return
		}
		wf = existing
		wf.Steps = append(wf.Steps, step)
	} else {
		wf = store.GoldenWorkflow{
			ID:          newID("gwf"),
			Name:        strings.TrimSpace(p.WorkflowName),
			Description: "Promoted from multi-model run " + runID,
			Steps:       []store.GoldenWorkflowStep{step},
			Tags:        []string{"multimodel"},
			CreatedAt:   time.Now().UTC(),
		}
	}
	if err := s.db.UpsertGoldenWorkflow(r.Context(), wf); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_save_failed")
		return
	}
	s.auditAdmin(r, "chat_test.multi_run_golden", runID, auditJSON(map[string]any{
		"workflow_id": wf.ID, "step": stepName, "model": p.SelectedModel, "baseline": baseline,
	}))
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "saved", "workflow_id": wf.ID, "workflow_name": wf.Name,
		"step_name": stepName, "step_count": len(wf.Steps), "baseline_score": baseline,
	})
}
