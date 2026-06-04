package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

var validQuotaScopes = map[string]bool{"api_key": true, "team": true, "ip": true, "global": true}
var validQuotaPeriods = map[string]bool{"daily": true, "monthly": true}

func (s *Server) handleQuotas(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		quotas, err := s.db.ListQuotas(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "quotas_failed")
			return
		}
		usage := make([]store.QuotaUsage, 0, len(quotas))
		now := time.Now()
		for _, q := range quotas {
			start, end := periodBounds(q.Period, now)
			_, cost, tokens, err := s.db.UsageSince(r.Context(), store.UsageFilter{Scope: q.Scope, ScopeValue: q.ScopeValue, Since: start})
			if err != nil {
				continue
			}
			tokenRatio := -1.0
			if q.TokenLimit > 0 {
				tokenRatio = 1 - float64(tokens)/float64(q.TokenLimit)
				if tokenRatio < 0 {
					tokenRatio = 0
				}
			}
			krwRatio := -1.0
			if q.KRWLimit > 0 {
				krwRatio = 1 - cost/q.KRWLimit
				if krwRatio < 0 {
					krwRatio = 0
				}
			}
			usage = append(usage, store.QuotaUsage{
				Quota:            q,
				Tokens:           tokens,
				CostKRW:          cost,
				PeriodStart:      start.UTC().Format(time.RFC3339Nano),
				PeriodEnd:        end.UTC().Format(time.RFC3339Nano),
				TokenRemainRatio: tokenRatio,
				KRWRemainRatio:   krwRatio,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"quotas": quotas, "usage": usage})
	case http.MethodPost:
		var payload struct {
			Scope      string  `json:"scope"`
			ScopeValue string  `json:"scope_value"`
			Period     string  `json:"period"`
			TokenLimit int64   `json:"token_limit"`
			KRWLimit   float64 `json:"krw_limit"`
			Enabled    *bool   `json:"enabled"`
			Note       string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Scope = strings.TrimSpace(payload.Scope)
		payload.ScopeValue = strings.TrimSpace(payload.ScopeValue)
		payload.Period = strings.TrimSpace(payload.Period)
		if !validQuotaScopes[payload.Scope] {
			writeOpenAIError(w, http.StatusBadRequest, "scope must be one of api_key/team/ip/global", "invalid_request_error", "invalid_scope")
			return
		}
		if payload.Scope == "global" {
			payload.ScopeValue = "*"
		} else if payload.ScopeValue == "" {
			writeOpenAIError(w, http.StatusBadRequest, "scope_value is required", "invalid_request_error", "missing_scope_value")
			return
		}
		if !validQuotaPeriods[payload.Period] {
			writeOpenAIError(w, http.StatusBadRequest, "period must be daily or monthly", "invalid_request_error", "invalid_period")
			return
		}
		if payload.TokenLimit < 0 || payload.KRWLimit < 0 {
			writeOpenAIError(w, http.StatusBadRequest, "limits must be non-negative", "invalid_request_error", "invalid_limits")
			return
		}
		if payload.TokenLimit == 0 && payload.KRWLimit == 0 {
			writeOpenAIError(w, http.StatusBadRequest, "token_limit or krw_limit must be positive", "invalid_request_error", "missing_limit")
			return
		}
		enabled := true
		if payload.Enabled != nil {
			enabled = *payload.Enabled
		}
		record := store.QuotaRecord{
			ID:         newID("quota"),
			Scope:      payload.Scope,
			ScopeValue: payload.ScopeValue,
			Period:     payload.Period,
			TokenLimit: payload.TokenLimit,
			KRWLimit:   payload.KRWLimit,
			Enabled:    enabled,
			Note:       strings.TrimSpace(payload.Note),
		}
		if err := s.db.UpsertQuota(r.Context(), record); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "quota_save_failed")
			return
		}
		s.auditAdmin(r, "quota.create", "", auditJSON(record))
		writeJSON(w, http.StatusCreated, map[string]any{"quota": record})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleQuotaByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/quotas/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid quota id", "invalid_request_error", "invalid_quota_id")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		quotas, err := s.db.ListQuotas(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "quota_lookup_failed")
			return
		}
		var current *store.QuotaPublic
		for i := range quotas {
			if quotas[i].ID == id {
				current = &quotas[i]
				break
			}
		}
		if current == nil {
			writeOpenAIError(w, http.StatusNotFound, "quota not found", "invalid_request_error", "quota_not_found")
			return
		}
		var payload struct {
			TokenLimit *int64   `json:"token_limit"`
			KRWLimit   *float64 `json:"krw_limit"`
			Enabled    *bool    `json:"enabled"`
			Note       *string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		updated := store.QuotaRecord{
			ID:         current.ID,
			Scope:      current.Scope,
			ScopeValue: current.ScopeValue,
			Period:     current.Period,
			TokenLimit: current.TokenLimit,
			KRWLimit:   current.KRWLimit,
			Enabled:    current.Enabled,
			Note:       current.Note,
		}
		if payload.TokenLimit != nil {
			updated.TokenLimit = *payload.TokenLimit
		}
		if payload.KRWLimit != nil {
			updated.KRWLimit = *payload.KRWLimit
		}
		if payload.Enabled != nil {
			updated.Enabled = *payload.Enabled
		}
		if payload.Note != nil {
			updated.Note = strings.TrimSpace(*payload.Note)
		}
		if updated.TokenLimit < 0 || updated.KRWLimit < 0 {
			writeOpenAIError(w, http.StatusBadRequest, "limits must be non-negative", "invalid_request_error", "invalid_limits")
			return
		}
		if err := s.db.UpsertQuota(r.Context(), updated); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "quota_save_failed")
			return
		}
		s.auditAdmin(r, "quota.update", auditJSON(current), auditJSON(updated))
		writeJSON(w, http.StatusOK, map[string]any{"quota": updated})
	case http.MethodDelete:
		if err := s.db.DeleteQuota(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "quota_delete_failed")
			return
		}
		s.auditAdmin(r, "quota.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
