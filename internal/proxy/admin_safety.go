package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleKillSwitch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, killSwitchPayload(s.killSnapshot(r.Context())))
	case http.MethodPost:
		var payload struct {
			Disabled bool   `json:"disabled"`
			Reason   string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		flag := store.RuntimeFlag{
			Key:       "gateway_disabled",
			Value:     boolStr(payload.Disabled),
			UpdatedAt: time.Now().UTC(),
			UpdatedBy: adminID(r),
			Note:      strings.TrimSpace(payload.Reason),
		}
		if err := s.db.SetFlag(r.Context(), flag); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "kill_switch_save_failed")
			return
		}
		s.invalidateKillCache()
		s.auditAdmin(r, "kill_switch.set", "", auditJSON(map[string]any{"disabled": payload.Disabled, "reason": payload.Reason}))
		writeJSON(w, http.StatusOK, killSwitchPayload(s.killSnapshot(r.Context())))
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func killSwitchPayload(snap *killSnapshot) map[string]any {
	if snap == nil {
		return map[string]any{"disabled": false}
	}
	return map[string]any{
		"disabled":   snap.disabled,
		"reason":     snap.reason,
		"updated_at": snap.updatedAt.UTC().Format(time.RFC3339),
		"updated_by": snap.updatedBy,
	}
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// ---------- alert rules ----------

var validAlertMetrics = map[string]bool{
	"requests":              true,
	"errors":                true,
	"krw":                   true,
	"tokens":                true,
	"latency_p95_ms":        true,
	"first_chunk_p95_ms":    true,
	"llm_eval_failures":     true,
	"llm_eval_failure_rate": true,
}
var validAlertScopes = map[string]bool{"global": true, "api_key": true, "team": true, "ip": true, "model": true}

func (s *Server) handleAlertRules(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		rules, err := s.db.ListAlertRules(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alerts_failed")
			return
		}
		events, err := s.db.ListAlertEvents(r.Context(), 50)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alerts_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rules": rules, "events": events})
	case http.MethodPost:
		var payload struct {
			Name          string  `json:"name"`
			Metric        string  `json:"metric"`
			WindowSeconds int     `json:"window_seconds"`
			Threshold     float64 `json:"threshold"`
			Scope         string  `json:"scope"`
			ScopeValue    string  `json:"scope_value"`
			WebhookURL    string  `json:"webhook_url"`
			Enabled       *bool   `json:"enabled"`
			Note          string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.Metric = strings.TrimSpace(payload.Metric)
		payload.Scope = strings.TrimSpace(payload.Scope)
		if payload.Scope == "" {
			payload.Scope = "global"
		}
		if payload.Scope == "global" {
			payload.ScopeValue = "*"
		} else {
			payload.ScopeValue = strings.TrimSpace(payload.ScopeValue)
		}
		if payload.Name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		if !validAlertMetrics[payload.Metric] {
			writeOpenAIError(w, http.StatusBadRequest, "metric must be one of requests/errors/krw/tokens/latency_p95_ms/first_chunk_p95_ms/llm_eval_failures/llm_eval_failure_rate", "invalid_request_error", "invalid_metric")
			return
		}
		if !validAlertScopes[payload.Scope] {
			writeOpenAIError(w, http.StatusBadRequest, "scope must be one of global/api_key/team/ip/model", "invalid_request_error", "invalid_scope")
			return
		}
		if payload.WindowSeconds <= 0 {
			payload.WindowSeconds = 300
		}
		if payload.Threshold <= 0 {
			writeOpenAIError(w, http.StatusBadRequest, "threshold must be positive", "invalid_request_error", "invalid_threshold")
			return
		}
		enabled := true
		if payload.Enabled != nil {
			enabled = *payload.Enabled
		}
		rule := store.AlertRule{
			ID:            newID("alert"),
			Name:          payload.Name,
			Metric:        payload.Metric,
			WindowSeconds: payload.WindowSeconds,
			Threshold:     payload.Threshold,
			Scope:         payload.Scope,
			ScopeValue:    payload.ScopeValue,
			WebhookURL:    strings.TrimSpace(payload.WebhookURL),
			Enabled:       enabled,
			Note:          strings.TrimSpace(payload.Note),
		}
		if err := s.db.UpsertAlertRule(r.Context(), rule); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alert_save_failed")
			return
		}
		s.auditAdmin(r, "alert.create", "", auditJSON(rule))
		writeJSON(w, http.StatusCreated, map[string]any{"rule": rule})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleAlertRuleByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/alerts/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid rule id", "invalid_request_error", "invalid_rule_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeleteAlertRule(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alert_delete_failed")
			return
		}
		s.auditAdmin(r, "alert.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		rules, err := s.db.ListAlertRules(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alert_lookup_failed")
			return
		}
		var current *store.AlertRule
		for i := range rules {
			if rules[i].ID == id {
				current = &rules[i]
				break
			}
		}
		if current == nil {
			writeOpenAIError(w, http.StatusNotFound, "rule not found", "invalid_request_error", "rule_not_found")
			return
		}
		var payload struct {
			Threshold  *float64 `json:"threshold"`
			Enabled    *bool    `json:"enabled"`
			WebhookURL *string  `json:"webhook_url"`
			Note       *string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		updated := *current
		if payload.Threshold != nil {
			updated.Threshold = *payload.Threshold
		}
		if payload.Enabled != nil {
			updated.Enabled = *payload.Enabled
		}
		if payload.WebhookURL != nil {
			updated.WebhookURL = strings.TrimSpace(*payload.WebhookURL)
		}
		if payload.Note != nil {
			updated.Note = strings.TrimSpace(*payload.Note)
		}
		if err := s.db.UpsertAlertRule(r.Context(), updated); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "alert_save_failed")
			return
		}
		s.auditAdmin(r, "alert.update", auditJSON(current), auditJSON(updated))
		writeJSON(w, http.StatusOK, map[string]any{"rule": updated})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
