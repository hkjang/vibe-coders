package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

var validBudgetScopes = map[string]bool{"global": true, "api_key": true, "team": true}

func (s *Server) handleBudgets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		statuses, err := s.db.BudgetStatuses(r.Context(), time.Now())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "budgets_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"budgets": statuses})
	case http.MethodPost:
		var p struct {
			Scope      string  `json:"scope"`
			ScopeValue string  `json:"scope_value"`
			MonthlyKRW float64 `json:"monthly_krw"`
			Note       string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Scope = strings.TrimSpace(p.Scope)
		if !validBudgetScopes[p.Scope] {
			writeOpenAIError(w, http.StatusBadRequest, "scope must be global/api_key/team", "invalid_request_error", "invalid_scope")
			return
		}
		if p.Scope == "global" {
			p.ScopeValue = "*"
		} else if strings.TrimSpace(p.ScopeValue) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "scope_value is required", "invalid_request_error", "missing_scope_value")
			return
		}
		if p.MonthlyKRW <= 0 {
			writeOpenAIError(w, http.StatusBadRequest, "monthly_krw must be positive", "invalid_request_error", "invalid_budget")
			return
		}
		b := store.Budget{
			ID:         newID("budget"),
			Scope:      p.Scope,
			ScopeValue: strings.TrimSpace(p.ScopeValue),
			MonthlyKRW: p.MonthlyKRW,
			Note:       strings.TrimSpace(p.Note),
		}
		if err := s.db.UpsertBudget(r.Context(), b); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "budget_save_failed")
			return
		}
		s.auditAdmin(r, "budget.create", "", auditJSON(b))
		writeJSON(w, http.StatusCreated, map[string]any{"budget": b})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleBudgetProjection forecasts each team's month-end spend at the current
// run-rate and flags teams projected to exceed their team budget.
// GET /admin/budgets/projection
func (s *Server) handleBudgetProjection(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teams, err := s.db.TeamMonthlyForecast(r.Context(), time.Now())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_forecast_failed")
		return
	}
	// team_admin sees only its own team.
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" {
		filtered := teams[:0]
		for _, t := range teams {
			if s.claimsTeamMatches(r, claims, t.Team) {
				filtered = append(filtered, t)
			}
		}
		teams = filtered
	}
	exceeding := 0
	for _, t := range teams {
		if t.WillExceed {
			exceeding++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams, "exceeding": exceeding})
}

func (s *Server) handleBudgetByID(w http.ResponseWriter, r *http.Request) {
	if strings.TrimPrefix(r.URL.Path, "/admin/budgets/") == "projection" {
		s.handleBudgetProjection(w, r)
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/budgets/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid budget id", "invalid_request_error", "invalid_budget_id")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if err := s.db.DeleteBudget(r.Context(), id); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "budget_delete_failed")
		return
	}
	s.auditAdmin(r, "budget.delete", auditJSON(map[string]string{"id": id}), "")
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
}
