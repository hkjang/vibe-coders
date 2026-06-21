package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handleModelContracts manages per-task-type model quality contracts (admin).
// GET    /admin/models/contracts[?enabled=1]   list
// POST   /admin/models/contracts               upsert
// DELETE /admin/models/contracts?id=..          delete
func (s *Server) handleModelContracts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		items, err := s.db.ListModelContracts(ctx, r.URL.Query().Get("enabled") == "1")
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"contracts": items})
	case http.MethodPost:
		var p struct {
			ID                string  `json:"id"`
			Name              string  `json:"name"`
			TaskType          string  `json:"task_type"`
			MinQualityScore   float64 `json:"min_quality_score"`
			MinGoldenPassRate float64 `json:"min_golden_pass_rate"`
			MinSuccessRate    float64 `json:"min_success_rate"`
			MaxLatencyMS      int64   `json:"max_latency_ms"`
			MaxAvgCostKRW     float64 `json:"max_avg_cost_krw"`
			Enabled           *bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "no_name")
			return
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		c := store.ModelContract{
			ID: firstNonEmpty(strings.TrimSpace(p.ID), newID("mcon")), Name: strings.TrimSpace(p.Name),
			TaskType: strings.TrimSpace(p.TaskType), MinQualityScore: p.MinQualityScore,
			MinGoldenPassRate: p.MinGoldenPassRate, MinSuccessRate: p.MinSuccessRate,
			MaxLatencyMS: p.MaxLatencyMS, MaxAvgCostKRW: p.MaxAvgCostKRW, Enabled: enabled, CreatedBy: adminID(r),
		}
		if err := s.db.UpsertModelContract(ctx, c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "upsert_failed")
			return
		}
		s.auditAdmin(r, "model_contract_upsert", "", auditJSON(map[string]any{"id": c.ID, "name": c.Name, "task_type": c.TaskType}))
		writeJSON(w, http.StatusOK, map[string]any{"id": c.ID, "ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param required", "invalid_request_error", "no_id")
			return
		}
		if err := s.db.DeleteModelContract(ctx, id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "model_contract_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

type contractCheck struct {
	Dimension string  `json:"dimension"`
	Threshold any     `json:"threshold"`
	Actual    any     `json:"actual"`
	Status    string  `json:"status"` // pass | warn | fail | no_data | skip
}

// handleModelContractsRun evaluates a candidate model against one or all enabled contracts using
// the model's observed quality/golden/latency/cost metrics. Returns pass/warn/fail per contract,
// whether the model is safe to adopt, and failing-sample fingerprints (no raw responses).
// POST /admin/models/contracts/run {model, contract_id?, window?}
func (s *Server) handleModelContractsRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Model      string `json:"model"`
		ContractID string `json:"contract_id"`
		Window     string `json:"window"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	model := strings.TrimSpace(p.Model)
	if model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model is required", "invalid_request_error", "no_model")
		return
	}
	ctx := r.Context()
	since := parseWindow(p.Window, 30*24*time.Hour, "day")

	// Gather the model's observed metrics.
	var quality store.ModelQualityScore
	haveQuality := false
	if qs, err := s.db.ModelQualityScores(ctx, since); err == nil {
		for _, q := range qs {
			if q.Model == model {
				quality = q
				haveQuality = true
				break
			}
		}
	}
	var latency float64
	haveLatency := false
	if stats, err := s.db.ModelStats(ctx, since); err == nil {
		if st, ok := stats[model]; ok {
			latency = st.AvgLatencyMS
			haveLatency = true
		}
	}
	var avgCost float64
	haveCost := false
	if costs, err := s.db.ModelAvgCost(ctx, since); err == nil {
		if c, ok := costs[model]; ok {
			avgCost = c
			haveCost = true
		}
	}

	// Resolve contracts to run.
	contracts := []store.ModelContract{}
	if id := strings.TrimSpace(p.ContractID); id != "" {
		c, found, err := s.db.GetModelContract(ctx, id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "contract_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "contract not found", "invalid_request_error", "not_found")
			return
		}
		contracts = append(contracts, c)
	} else {
		all, err := s.db.ListModelContracts(ctx, true)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		contracts = all
	}

	results := make([]map[string]any, 0, len(contracts))
	overallReplaceable := true
	for _, c := range contracts {
		checks := []contractCheck{}
		if c.MinQualityScore > 0 {
			checks = append(checks, evalMin("quality_score", quality.QualityScore, c.MinQualityScore, haveQuality))
		}
		if c.MinGoldenPassRate > 0 {
			checks = append(checks, evalMin("golden_pass_rate", quality.GoldenPassRate, c.MinGoldenPassRate, haveQuality && quality.GoldenSamples > 0))
		}
		if c.MinSuccessRate > 0 {
			checks = append(checks, evalMin("success_rate", quality.SuccessRate, c.MinSuccessRate, haveQuality))
		}
		if c.MaxLatencyMS > 0 {
			checks = append(checks, evalMax("avg_latency_ms", latency, float64(c.MaxLatencyMS), haveLatency))
		}
		if c.MaxAvgCostKRW > 0 {
			checks = append(checks, evalMax("avg_cost_krw", avgCost, c.MaxAvgCostKRW, haveCost))
		}
		verdict := contractVerdict(checks)
		replaceable := verdict == "pass" || verdict == "warn"
		if !replaceable {
			overallReplaceable = false
		}
		results = append(results, map[string]any{
			"contract_id": c.ID, "contract_name": c.Name, "task_type": c.TaskType,
			"verdict": verdict, "replaceable": replaceable, "checks": checks,
		})
	}

	// Failing-sample fingerprints (no raw response).
	samples := []map[string]any{}
	if failed, err := s.db.FailedGoldenForModel(ctx, model, since, 20); err == nil {
		for _, g := range failed {
			samples = append(samples, map[string]any{
				"fingerprint": audit.HashText(g.PromptID)[:12],
				"reason":      "golden score " + ftoa(g.Score) + " (failed)",
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"model":             model,
		"window":            since.UTC().Format(time.RFC3339),
		"have_metrics":      map[string]any{"quality": haveQuality, "latency": haveLatency, "cost": haveCost},
		"results":           results,
		"replaceable":       overallReplaceable && len(contracts) > 0,
		"failing_samples":   samples,
		"note":              "관측된 모델 지표를 계약 임계값과 비교합니다. 실패 샘플은 원문 없이 fingerprint와 사유만 표시합니다. 계약이 없거나 지표가 부족하면 교체 안전을 보장하지 않습니다.",
	})
}

// evalMin classifies an at-least threshold: fail below, warn within 5% above, else pass.
func evalMin(dim string, actual, min float64, haveData bool) contractCheck {
	c := contractCheck{Dimension: dim, Threshold: round1(min), Actual: round1(actual)}
	if !haveData {
		c.Status = "no_data"
		c.Actual = nil
		return c
	}
	switch {
	case actual < min:
		c.Status = "fail"
	case actual < min*1.05:
		c.Status = "warn"
	default:
		c.Status = "pass"
	}
	return c
}

// evalMax classifies an at-most threshold: fail above, warn within 5% below, else pass.
func evalMax(dim string, actual, max float64, haveData bool) contractCheck {
	c := contractCheck{Dimension: dim, Threshold: round1(max), Actual: round1(actual)}
	if !haveData {
		c.Status = "no_data"
		c.Actual = nil
		return c
	}
	switch {
	case actual > max:
		c.Status = "fail"
	case actual > max*0.95:
		c.Status = "warn"
	default:
		c.Status = "pass"
	}
	return c
}

// contractVerdict reduces per-dimension checks to a single verdict (fail > no_data > warn > pass).
func contractVerdict(checks []contractCheck) string {
	if len(checks) == 0 {
		return "no_data"
	}
	hasNoData, hasWarn := false, false
	for _, c := range checks {
		switch c.Status {
		case "fail":
			return "fail"
		case "no_data":
			hasNoData = true
		case "warn":
			hasWarn = true
		}
	}
	if hasNoData {
		return "no_data"
	}
	if hasWarn {
		return "warn"
	}
	return "pass"
}
