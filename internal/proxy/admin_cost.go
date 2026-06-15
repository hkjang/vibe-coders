package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handleAICreditScore returns a per-subject "AI credit score" blending reliability
// (success rate) and cost efficiency over a window. Read-only operational signal.
// GET /admin/ai-credit-score?dimension=api_key_id&window=7d
func (s *Server) handleAICreditScore(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "api_key_id"
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	scores, err := s.db.AICreditScores(r.Context(), dimension, since, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "credit_score_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dimension": dimension, "scores": scores})
}

// handleCarbonScore estimates per-subject energy (Wh) and operational carbon (gCO2e)
// from logged token throughput, applying per-model energy coefficients. Coarse,
// configurable, read-only operational signal.
// GET /admin/carbon-score?dimension=model&window=7d
func (s *Server) handleCarbonScore(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "model"
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	coeff := store.CarbonCoeff{
		DefaultWhPer1K:  s.cfg.Carbon.WhPer1KTokens,
		PerModelWhPer1K: s.cfg.Carbon.PerModelWhPer1K,
		PUE:             s.cfg.Carbon.PUE,
		GridIntensityG:  s.cfg.Carbon.GridIntensityG,
	}
	scores, err := s.db.CarbonScores(r.Context(), dimension, since, recentLimit(r), coeff)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "carbon_score_failed")
		return
	}
	var totalWh, totalCO2e float64
	for _, c := range scores {
		totalWh += c.EnergyWh
		totalCO2e += c.CO2eGrams
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dimension":        dimension,
		"scores":           scores,
		"total_energy_wh":  totalWh,
		"total_co2e_grams": totalCO2e,
		"coefficients": map[string]any{
			"wh_per_1k_tokens": coeff.DefaultWhPer1K,
			"pue":              coeff.PUE,
			"grid_intensity_g": coeff.GridIntensityG,
		},
	})
}

// handleWorkMap returns the AI Work Map: a consolidated per-node summary (volume,
// tokens, cost, distinct users/models, error rate, dominant model, task-type
// breakdown) of what AI work is happening under a work dimension. Read-only.
// GET /admin/work-map?dimension=project&window=7d
func (s *Server) handleWorkMap(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "project"
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	nodes, err := s.db.WorkMap(r.Context(), dimension, since, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "work_map_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dimension": dimension, "nodes": nodes})
}

// handleSavings returns the Savings Report: per scope, how much the gateway saved via
// routing downshifts (served a cheaper model than requested — priced exactly against the
// requested model) and via cache hits (estimated as avoided cost). Read-only.
// GET /admin/savings?dimension=project&window=7d
func (s *Server) handleSavings(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "project"
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	ctx := r.Context()

	downshift, err := s.db.RoutingDownshiftUsage(ctx, dimension, since)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "savings_failed")
		return
	}
	cacheRows, err := s.db.CacheUsage(ctx, dimension, since)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "savings_failed")
		return
	}
	pricing := s.pricingMap(ctx)

	type savingsScope struct {
		Scope               string  `json:"scope"`
		DownshiftRequests   int64   `json:"downshift_requests"`
		DownshiftSavingsKRW float64 `json:"downshift_savings_krw"`
		CacheHits           int64   `json:"cache_hits"`
		CacheSavingsKRW     float64 `json:"cache_savings_krw"` // estimated
		TotalSavingsKRW     float64 `json:"total_savings_krw"`
	}
	scopes := map[string]*savingsScope{}
	get := func(name string) *savingsScope {
		sc := scopes[name]
		if sc == nil {
			sc = &savingsScope{Scope: name}
			scopes[name] = sc
		}
		return sc
	}

	// Exact downshift savings: baseline at the requested model minus actual cost.
	for _, d := range downshift {
		baseline := audit.EstimateCostKRW(d.RequestedModel, audit.Usage{
			PromptTokens: int(d.PromptTokens), CompletionTokens: int(d.CompletionTokens), CachedTokens: int(d.CachedTokens),
		}, pricing)
		saved := baseline - d.ActualCostKRW
		if saved < 0 {
			saved = 0
		}
		sc := get(d.Scope)
		sc.DownshiftRequests += d.Requests
		sc.DownshiftSavingsKRW += saved
	}
	// Estimated cache savings: cache hits × average non-cache cost per request in scope.
	for _, c := range cacheRows {
		if c.CacheHits == 0 {
			continue
		}
		sc := get(c.Scope)
		sc.CacheHits += c.CacheHits
		if c.NonCacheRequests > 0 {
			sc.CacheSavingsKRW += float64(c.CacheHits) * (c.NonCacheCostKRW / float64(c.NonCacheRequests))
		}
	}

	out := make([]savingsScope, 0, len(scopes))
	var totalDownshift, totalCache float64
	for _, sc := range scopes {
		sc.TotalSavingsKRW = sc.DownshiftSavingsKRW + sc.CacheSavingsKRW
		if sc.TotalSavingsKRW <= 0 && sc.CacheHits == 0 && sc.DownshiftRequests == 0 {
			continue
		}
		totalDownshift += sc.DownshiftSavingsKRW
		totalCache += sc.CacheSavingsKRW
		out = append(out, *sc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TotalSavingsKRW > out[j].TotalSavingsKRW })
	limit := recentLimit(r)
	if len(out) > limit {
		out = out[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dimension":                 dimension,
		"total_downshift_savings_krw": totalDownshift,
		"total_cache_savings_krw":     totalCache,
		"total_savings_krw":           totalDownshift + totalCache,
		"cache_savings_estimated":     true,
		"scopes":                      out,
	})
}

// handleInsuranceClaims returns the AI Request Insurance ledger: per insured scope it
// treats requests as "covered" and degraded outcomes (4xx/5xx/failover/error) as
// "claims", comparing the claim rate to an SLA target to surface breaches. Read-only.
// GET /admin/insurance/claims?dimension=project&window=7d&sla=0.99
func (s *Server) handleInsuranceClaims(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "project"
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	slaTarget := s.cfg.Insurance.SLATarget
	if raw := strings.TrimSpace(r.URL.Query().Get("sla")); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			slaTarget = v
		}
	}
	claims, err := s.db.InsuranceClaims(r.Context(), dimension, since, recentLimit(r), slaTarget)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "insurance_failed")
		return
	}
	var totalCovered, totalClaims int64
	breaches := 0
	for _, c := range claims {
		totalCovered += c.Covered
		totalClaims += c.Claims
		if !c.SLAMet {
			breaches++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dimension": dimension, "sla_target": slaTarget,
		"total_covered": totalCovered, "total_claims": totalClaims, "scopes_in_breach": breaches,
		"scopes": claims,
	})
}

// handleCostGuard manages the pre-call cost guard config.
// GET /admin/cost → {enabled, threshold_krw}; POST sets it.
func (s *Server) handleCostGuard(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		snap := s.costSnapshotCached(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"enabled": snap.guardEnabled, "threshold_krw": snap.guardThreshold})
	case http.MethodPost:
		var p struct {
			Enabled      *bool    `json:"enabled"`
			ThresholdKRW *float64 `json:"threshold_krw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Enabled != nil {
			if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "cost_guard_enabled", Value: boolStr(*p.Enabled), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "cost_guard_save_failed")
				return
			}
		}
		if p.ThresholdKRW != nil {
			if *p.ThresholdKRW < 0 {
				writeOpenAIError(w, http.StatusBadRequest, "threshold_krw must be >= 0", "invalid_request_error", "invalid_threshold")
				return
			}
			if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "cost_guard_threshold_krw", Value: strconv.FormatFloat(*p.ThresholdKRW, 'f', -1, 64), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "cost_guard_save_failed")
				return
			}
		}
		s.invalidateCostCache()
		s.auditAdmin(r, "cost_guard.set", "", auditJSON(p))
		snap := s.costSnapshotCached(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"enabled": snap.guardEnabled, "threshold_krw": snap.guardThreshold})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleCostAllocation attributes cost/requests/tokens/errors to a dimension
// (repo, branch, project, service, cost_center, model, provider, api_key_id)
// over a window (default 30d). GET /admin/cost/allocation?dimension=repo&window=30d
func (s *Server) handleCostAllocation(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "project"
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	rows, err := s.db.CostAllocation(r.Context(), dimension, since, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_dimension")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dimension":  dimension,
		"dimensions": store.CostAllocationDimensions(),
		"since":      since.UTC().Format(time.RFC3339),
		"rows":       rows,
	})
}

// handleCostAnomalies surfaces two forward-looking cost risks:
//   - budget projections (per scope/team) that are forecast to exceed their
//     monthly budget at the current run-rate, and
//   - sessions repeating the same prompt fingerprint (likely runaway agent loops
//     burning cost).
//
// GET /admin/cost/anomalies?window=6h&min_repeats=5&projected_ratio=1.0
func (s *Server) handleCostAnomalies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	now := time.Now().UTC()
	statuses, err := s.db.BudgetStatuses(r.Context(), now)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "budget_status_failed")
		return
	}
	projectedRatio := 1.0
	if v := strings.TrimSpace(r.URL.Query().Get("projected_ratio")); v != "" {
		if parsed, perr := strconv.ParseFloat(v, 64); perr == nil && parsed > 0 {
			projectedRatio = parsed
		}
	}
	overProjected := []store.BudgetStatus{}
	for _, st := range statuses {
		if st.Budget.MonthlyKRW > 0 && st.ProjectedRatio >= projectedRatio {
			overProjected = append(overProjected, st)
		}
	}

	since := parseWindow(r.URL.Query().Get("window"), 6*time.Hour, "hour")
	minRepeats := 5
	if v := strings.TrimSpace(r.URL.Query().Get("min_repeats")); v != "" {
		if parsed, perr := strconv.Atoi(v); perr == nil && parsed > 0 {
			minRepeats = parsed
		}
	}
	loops, err := s.db.SessionLoopAnomalies(r.Context(), since, minRepeats, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "session_loops_failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"budget_projections": statuses,
		"over_projected":     overProjected,
		"session_loops":      loops,
		"window_since":       since.UTC().Format(time.RFC3339),
		"projected_ratio":    projectedRatio,
	})
}

// handleCostPredict is a dry-run estimator for the UI calculator.
// POST /admin/cost/predict {model, input_tokens?, max_tokens?, messages?[]}
func (s *Server) handleCostPredict(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Model       string `json:"model"`
		InputTokens int    `json:"input_tokens"`
		MaxTokens   int    `json:"max_tokens"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if p.Model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model is required", "invalid_request_error", "missing_model")
		return
	}
	snap := s.costSnapshotCached(r.Context())
	est := predictCost(p.Model, p.InputTokens, p.MaxTokens, snap, s.pricingMap(r.Context()))
	writeJSON(w, http.StatusOK, est)
}
