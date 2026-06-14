package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleRoutingPreview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	authCtx, policyKeyID, ok := s.routingPreviewAuthContext(w, r, probe)
	if !ok {
		return
	}
	plan := s.planIntelligentRouting(r.Context(), body, "/v1/chat/completions", false, false, authCtx)
	writeJSON(w, http.StatusOK, map[string]any{
		"requested_model":   plan.RequestedModel,
		"selected_model":    plan.SelectedModel,
		"selected_provider": plan.SelectedProvider,
		"policy_api_key_id": policyKeyID,
		"complexity":        plan.Complexity,
		"risk":              plan.Risk,
		"health_score":      plan.HealthScore,
		"fallback_path":     plan.FallbackPath,
		"decision_reason":   plan.DecisionReason,
		"would_rewrite":     plan.RequestedModel != "" && plan.SelectedModel != "" && plan.RequestedModel != plan.SelectedModel,
	})
}

func (s *Server) routingPreviewAuthContext(w http.ResponseWriter, r *http.Request, probe map[string]any) (*store.AuthContext, string, bool) {
	apiKeyID := strings.TrimSpace(toString(probe["api_key_id"]))
	if apiKeyID == "" {
		return nil, "", true
	}
	key, found, err := s.db.GetAPIKey(r.Context(), apiKeyID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_lookup_failed")
		return nil, "", false
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
		return nil, "", false
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && key.Team != claims.TeamID {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only preview own team api keys", "permission_error", "team_scope_denied")
		return nil, "", false
	}
	authCtx := authContextFromAPIKey(key)
	s.enrichAuthContextTeam(r.Context(), &authCtx)
	return &authCtx, key.ID, true
}

func (s *Server) handleRoutingDecisions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	decisions, err := s.db.ListRoutingDecisions(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decisions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decisions": decisions})
}

func (s *Server) handleRoutingDecisionByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/routing/decisions/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid decision id", "invalid_request_error", "invalid_decision_id")
		return
	}
	decision, err := s.db.RoutingDecisionByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "routing decision not found", "invalid_request_error", "routing_decision_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decision_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decision": decision})
}

func (s *Server) handleRoutingHealth(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), providerHealthWindow, "hour")
	scores, err := s.db.ProviderHealthScores(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_health_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":     since.UTC().Format(time.RFC3339),
		"providers": scores,
	})
}
