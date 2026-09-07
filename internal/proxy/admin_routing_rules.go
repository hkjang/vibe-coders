package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

func (s *Server) handleRoutingRules(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		rules, err := s.db.ListRoutingRules(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_rules_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
	case http.MethodPost:
		var p struct {
			MatchPattern   string `json:"match_pattern"`
			MinComplexity  int    `json:"min_complexity"`
			MaxComplexity  int    `json:"max_complexity"`
			TargetModel    string `json:"target_model"`
			TargetProvider string `json:"target_provider"`
			Priority       int    `json:"priority"`
			Enabled        *bool  `json:"enabled"`
			Note           string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.MatchPattern = strings.TrimSpace(p.MatchPattern)
		if p.MatchPattern == "" {
			p.MatchPattern = "*"
		}
		p.TargetModel = strings.TrimSpace(p.TargetModel)
		if p.TargetModel == "" {
			writeOpenAIError(w, http.StatusBadRequest, "target_model is required", "invalid_request_error", "missing_target_model")
			return
		}
		if p.MinComplexity < 0 || p.MaxComplexity > 100 || p.MinComplexity > p.MaxComplexity {
			writeOpenAIError(w, http.StatusBadRequest, "complexity range must satisfy 0 <= min <= max <= 100", "invalid_request_error", "invalid_range")
			return
		}
		if p.Priority <= 0 {
			p.Priority = 100
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		rule := store.RoutingRule{
			ID:             newID("route"),
			Enabled:        enabled,
			Priority:       p.Priority,
			MatchPattern:   p.MatchPattern,
			MinComplexity:  p.MinComplexity,
			MaxComplexity:  p.MaxComplexity,
			TargetModel:    p.TargetModel,
			TargetProvider: strings.TrimSpace(p.TargetProvider),
			Note:           strings.TrimSpace(p.Note),
		}
		if err := s.db.UpsertRoutingRule(r.Context(), rule); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_rule_save_failed")
			return
		}
		s.invalidateRoutingRulesCache()
		s.auditAdmin(r, "routing_rule.create", "", auditJSON(rule))
		writeJSON(w, http.StatusCreated, map[string]any{"rule": rule})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleRoutingRuleByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/routing-rules/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid rule id", "invalid_request_error", "invalid_rule_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.DeleteRoutingRule(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_rule_delete_failed")
			return
		}
		s.invalidateRoutingRulesCache()
		s.auditAdmin(r, "routing_rule.delete", auditJSON(map[string]string{"id": id}), "")
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	case http.MethodPatch:
		rules, err := s.db.ListRoutingRules(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_rule_lookup_failed")
			return
		}
		var cur *store.RoutingRule
		for i := range rules {
			if rules[i].ID == id {
				cur = &rules[i]
				break
			}
		}
		if cur == nil {
			writeOpenAIError(w, http.StatusNotFound, "rule not found", "invalid_request_error", "rule_not_found")
			return
		}
		// Every field the create form accepts is editable here. Deleting and
		// recreating a rule was previously the only way to change a pattern or a
		// target, and live traffic routes differently for as long as the rule is
		// gone. Absent fields keep their stored value.
		var p struct {
			Enabled        *bool   `json:"enabled"`
			Priority       *int    `json:"priority"`
			MatchPattern   *string `json:"match_pattern"`
			MinComplexity  *int    `json:"min_complexity"`
			MaxComplexity  *int    `json:"max_complexity"`
			TargetModel    *string `json:"target_model"`
			TargetProvider *string `json:"target_provider"`
			Note           *string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		next := *cur
		if p.Enabled != nil {
			next.Enabled = *p.Enabled
		}
		if p.Priority != nil {
			if *p.Priority <= 0 {
				writeOpenAIError(w, http.StatusBadRequest, "priority must be positive", "invalid_request_error", "invalid_priority")
				return
			}
			next.Priority = *p.Priority
		}
		if p.MatchPattern != nil {
			pattern := strings.TrimSpace(*p.MatchPattern)
			if pattern == "" {
				pattern = "*"
			}
			next.MatchPattern = pattern
		}
		if p.MinComplexity != nil {
			next.MinComplexity = *p.MinComplexity
		}
		if p.MaxComplexity != nil {
			next.MaxComplexity = *p.MaxComplexity
		}
		if p.TargetModel != nil {
			target := strings.TrimSpace(*p.TargetModel)
			if target == "" {
				writeOpenAIError(w, http.StatusBadRequest, "target_model is required", "invalid_request_error", "missing_target_model")
				return
			}
			next.TargetModel = target
		}
		if p.TargetProvider != nil {
			next.TargetProvider = strings.TrimSpace(*p.TargetProvider)
		}
		if p.Note != nil {
			next.Note = strings.TrimSpace(*p.Note)
		}
		// Validate the merged rule, not the patch: changing only one bound must
		// not be able to leave the stored rule with an impossible range.
		if next.MinComplexity < 0 || next.MaxComplexity > 100 || next.MinComplexity > next.MaxComplexity {
			writeOpenAIError(w, http.StatusBadRequest, "complexity range must satisfy 0 <= min <= max <= 100", "invalid_request_error", "invalid_range")
			return
		}
		cur = &next
		if err := s.db.UpsertRoutingRule(r.Context(), *cur); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_rule_save_failed")
			return
		}
		s.invalidateRoutingRulesCache()
		s.auditAdmin(r, "routing_rule.update", "", auditJSON(cur))
		writeJSON(w, http.StatusOK, map[string]any{"rule": cur})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
