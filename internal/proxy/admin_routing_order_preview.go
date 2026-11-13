package proxy

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type routingOrderPreviewInput struct {
	Model      string   `json:"model"`
	Complexity int      `json:"complexity"`
	Order      []string `json:"rule_order"`
	Revision   string   `json:"rule_revision"`
}

type routingOrderPreviewDecision struct {
	MatchedRuleID  string `json:"matched_rule_id"`
	Applied        bool   `json:"applied"`
	TargetModel    string `json:"target_model"`
	TargetProvider string `json:"target_provider"`
}

// Compares only the complexity-rule stage. It does not execute the model,
// policy, user/team selection, learning, health checks or provider failover.
func (s *Server) handleRoutingOrderPreview(w http.ResponseWriter, r *http.Request, body []byte) {
	w.Header().Set("Cache-Control", "no-store")
	var input routingOrderPreviewInput
	if r.URL.RawQuery != "" || decodeRoutingOrderJSON(body, &input, "model", "complexity", "rule_order", "rule_revision") != nil {
		writeRoutingOrderError(w, store.ErrRoutingOrderInvalid)
		return
	}
	input.Model = strings.TrimSpace(input.Model)
	if input.Model == "" || utf8.RuneCountInString(input.Model) > 256 || input.Complexity < 0 || input.Complexity > 100 {
		writeRoutingOrderError(w, store.ErrRoutingOrderInvalid)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	before, err := s.db.GetRoutingOrderSnapshot(ctx)
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	if before.Revision != input.Revision {
		writeRoutingOrderError(w, store.ErrRoutingOrderConflict)
		return
	}
	proposed, err := store.ProposedRoutingOrder(before, input.Order)
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	project := func(rules []store.RoutingRule) routingOrderPreviewDecision {
		decision, matched := evaluateRoutingRuleOrder(rules, input.Model, input.Complexity)
		target := input.Model
		if decision.Applied {
			target = decision.TargetModel
		}
		result := routingOrderPreviewDecision{MatchedRuleID: matched, Applied: decision.Applied, TargetModel: target, TargetProvider: decision.TargetProvider}
		if !s.canViewRawPrompts(r) {
			args := s.externalCredentialProjectionArgs(result.TargetProvider)
			result.MatchedRuleID = audit.Redact(boundedExternalProviderText(result.MatchedRuleID, args...))
			result.TargetModel = audit.Redact(boundedExternalProviderText(result.TargetModel, args...))
			result.TargetProvider = boundedExternalProviderLabelOrEmpty(result.TargetProvider, args...)
		}
		return result
	}
	writeJSON(w, 200, map[string]any{
		"stage": "complexity_rules", "revision": before.Revision,
		"ambiguous_before_order": before.AmbiguousTies,
		"before":                 project(before.Rules), "after": project(proposed),
	})
}
