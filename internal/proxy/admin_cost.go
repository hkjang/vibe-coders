package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"vibe-coders/internal/store"
)

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
	est := predictCost(p.Model, p.InputTokens, p.MaxTokens, snap, s.cfg.Pricing)
	writeJSON(w, http.StatusOK, est)
}
