package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handlePromptLabTestCaseRun executes a saved test case across its models, auto-scores each
// response (rule rubric), validates the output contract, persists a multi-model run + the
// per-model judgements, and records a regression-history entry.
// POST /admin/prompt-lab/test-cases/{id}/run {models?: [...], save_prompt?: bool}
func (s *Server) handlePromptLabTestCaseRun(w http.ResponseWriter, r *http.Request, tcID string) {
	tc, found, err := s.db.GetPromptTestCase(r.Context(), tcID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "test case not found", "invalid_request_error", "not_found")
		return
	}
	var override struct {
		Models     []string `json:"models"`
		SavePrompt bool     `json:"save_prompt"`
	}
	_ = json.NewDecoder(r.Body).Decode(&override)

	var messages []map[string]any
	_ = json.Unmarshal([]byte(tc.MessagesJSON), &messages)
	if len(messages) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "test case has no messages", "invalid_request_error", "bad_test_case")
		return
	}
	models := override.Models
	if len(models) == 0 {
		_ = json.Unmarshal([]byte(tc.ModelsJSON), &models)
	}
	// De-dup + cap.
	seen := map[string]bool{}
	specs := []multiRunModelSpec{}
	for _, m := range models {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		specs = append(specs, multiRunModelSpec{Model: m})
	}
	if len(specs) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "no models specified (test case or request)", "invalid_request_error", "missing_models")
		return
	}
	if len(specs) > maxMultiRunModels {
		specs = specs[:maxMultiRunModels]
	}

	mr := multiRunRequest{Messages: messages}
	results := make([]multiRunResult, len(specs))
	var wg sync.WaitGroup
	for i, spec := range specs {
		wg.Add(1)
		go func(idx int, sp multiRunModelSpec) {
			defer wg.Done()
			results[idx] = s.runSingleModel(r, mr, sp)
		}(i, spec)
	}
	wg.Wait()

	// Persist as a multi-model run so Diff/Judge views work on it too.
	runID := newID("mmt")
	success, failed := 0, 0
	stored := make([]store.MultiModelTestResult, 0, len(results))
	minCost, maxCost, maxLen := -1.0, 0.0, 1
	for _, res := range results {
		if res.Status == "success" {
			success++
			if minCost < 0 || res.CostKRWEst < minCost {
				minCost = res.CostKRWEst
			}
			if res.CostKRWEst > maxCost {
				maxCost = res.CostKRWEst
			}
			if l := len(res.Content); l > maxLen {
				maxLen = l
			}
		} else {
			failed++
		}
		stored = append(stored, store.MultiModelTestResult{
			RunID: runID, Model: res.Model, Provider: res.Provider,
			Status: statusToOK(res.Status), StatusCode: res.StatusCode,
			LatencyMS: res.LatencyMS, InputTokens: res.InputTokens, OutputTokens: res.OutputTokens, TotalTokens: res.TotalTokens,
			CostKRW: res.CostKRWEst, ResponsePreview: truncateRunes(res.Content, 500), ResponseHash: audit.HashText(res.Content), Error: res.Error,
		})
	}
	run := store.MultiModelTestRun{
		ID: runID, Title: "PromptLab: " + tc.Name, CreatedBy: s.skillActor(r),
		PromptHash: tc.MessagesHash, ModelCount: len(specs), Success: success, Failed: failed,
	}
	if claims, ok := s.currentAccessClaims(r); ok {
		run.Team = claims.TeamID
	}
	if override.SavePrompt {
		run.PromptPreview = truncateRunes(firstUserMessage(messages, ""), 300)
	}
	_ = s.db.SaveMultiModelRun(r.Context(), run, stored)

	// Optional output contract.
	var contract store.PromptContract
	haveContract := false
	if tc.ContractID != "" {
		if c, ok, _ := s.db.GetPromptContract(r.Context(), tc.ContractID); ok {
			contract, haveContract = c, true
		}
	}

	// Score + contract-validate each successful model; build judgements.
	type perModel struct {
		Model        string   `json:"model"`
		Score        float64  `json:"score"`
		Verdict      string   `json:"verdict"`
		ContractPass *bool    `json:"contract_pass,omitempty"`
		ContractErr  []string `json:"contract_errors,omitempty"`
		CostKRW      float64  `json:"cost_krw"`
		LatencyMS    int64    `json:"latency_ms"`
		Status       string   `json:"status"`
	}
	pm := make([]perModel, 0, len(stored))
	judgements := make([]store.MultiModelTestJudgement, 0, len(stored))
	var scoreSum, costSum, latSum float64
	scored, contractPass := 0, 0
	best := ""
	bestScore := -1.0
	for _, res := range stored {
		row := perModel{Model: res.Model, Status: res.Status, CostKRW: res.CostKRW, LatencyMS: res.LatencyMS}
		j := store.MultiModelTestJudgement{ID: newID("mmj"), RunID: runID, Model: res.Model, Method: "rule", ResponseHash: res.ResponseHash, CreatedBy: s.skillActor(r)}
		if res.Status != "ok" || strings.TrimSpace(res.ResponsePreview) == "" {
			j.Verdict, j.ReasonSummary = "fail", "응답 없음"
			row.Verdict = "fail"
			judgements = append(judgements, j)
			pm = append(pm, row)
			continue
		}
		ruleScoreInto(&j, res, minCost, maxCost, maxLen)
		row.Score, row.Verdict = j.TotalScore, j.Verdict
		scoreSum += j.TotalScore
		costSum += res.CostKRW
		latSum += float64(res.LatencyMS)
		scored++
		if j.TotalScore > bestScore {
			bestScore = j.TotalScore
			best = res.Model
		}
		if haveContract {
			pass, errs := validateOutputContract(contract, res.ResponsePreview)
			row.ContractPass = &pass
			row.ContractErr = errs
			if pass {
				contractPass++
			} else if contract.Strict {
				// Strict contract failure caps the verdict at warn and notes it.
				if j.Verdict == "pass" {
					j.Verdict = "warn"
					row.Verdict = "warn"
				}
				j.ReasonSummary += " · 계약 위반"
			}
		}
		judgements = append(judgements, j)
		pm = append(pm, row)
	}
	_ = s.db.ReplaceMultiModelJudgements(r.Context(), runID, judgements)

	avgScore := 0.0
	if scored > 0 {
		avgScore = round1(scoreSum / float64(scored))
	}
	avgCost, avgLat := 0.0, 0.0
	if scored > 0 {
		avgCost = costSum / float64(scored)
		avgLat = latSum / float64(scored)
	}
	tcRun := store.PromptTestCaseRun{
		ID: newID("ptcr"), TestCaseID: tcID, RunID: runID, BestModel: best,
		AvgScore: avgScore, ContractPass: contractPass, ModelCount: len(specs),
		AvgCostKRW: avgCost, AvgLatencyMS: round1(avgLat), CreatedBy: s.skillActor(r),
	}
	_ = s.db.InsertPromptTestCaseRun(r.Context(), tcRun)

	s.auditAdmin(r, "prompt_lab.test_case_run", tcID, auditJSON(map[string]any{"run_id": runID, "best": best, "avg_score": avgScore, "contract_pass": contractPass}))

	history, _ := s.db.ListPromptTestCaseRuns(r.Context(), tcID, 30)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":           "completed",
		"run_id":           runID,
		"best_model":       best,
		"avg_score":        avgScore,
		"contract_applied": haveContract,
		"contract_pass":    contractPass,
		"model_count":      len(specs),
		"results":          pm,
		"history":          history,
	})
}

// statusToOK maps the multi-run "success" status to the stored "ok" status used by the
// judge/diff code paths.
func statusToOK(status string) string {
	if status == "success" {
		return "ok"
	}
	return status
}
