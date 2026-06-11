package proxy

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const routingRulesTTL = 5 * time.Second

type routingRulesSnapshot struct {
	rules     []store.RoutingRule
	fetchedAt time.Time
}

type routingDecision struct {
	Applied        bool
	OriginalModel  string
	TargetModel    string
	TargetProvider string
	Desc           string // e.g. "low(0-34) → gpt-4.1-mini"
	Reason         string
}

func (s *Server) routingRulesSnapshot(ctx context.Context) []store.RoutingRule {
	if cached := s.routingRules.Load(); cached != nil && time.Since(cached.fetchedAt) < routingRulesTTL {
		return cached.rules
	}
	snap := &routingRulesSnapshot{fetchedAt: time.Now()}
	if rules, err := s.db.ActiveRoutingRules(ctx); err == nil {
		snap.rules = rules
	}
	s.routingRules.Store(snap)
	return snap.rules
}

func (s *Server) invalidateRoutingRulesCache() { s.routingRules.Store(nil) }

// evaluateRoutingRules picks the first enabled rule whose model pattern matches the
// incoming model and whose complexity range covers the request, then returns the model
// (and optional provider) to route to. Returns Applied=false if nothing matches or the
// target equals the original model.
func (s *Server) evaluateRoutingRules(ctx context.Context, model string, complexity int) routingDecision {
	model = strings.TrimSpace(model)
	if model == "" {
		return routingDecision{}
	}
	normalized := strings.ToLower(model)
	for _, rule := range s.routingRulesSnapshot(ctx) {
		if complexity < rule.MinComplexity || complexity > rule.MaxComplexity {
			continue
		}
		pattern := strings.ToLower(strings.TrimSpace(rule.MatchPattern))
		if pattern == "" {
			pattern = "*"
		}
		if !matchGlob(pattern, normalized) {
			continue
		}
		target := strings.TrimSpace(rule.TargetModel)
		if target == "" || target == model {
			return routingDecision{} // no-op rule
		}
		return routingDecision{
			Applied:        true,
			OriginalModel:  model,
			TargetModel:    target,
			TargetProvider: strings.TrimSpace(rule.TargetProvider),
			Desc:           complexityTierName(complexity) + "(" + itoaProxy(rule.MinComplexity) + "-" + itoaProxy(rule.MaxComplexity) + ") " + model + " → " + target,
			Reason:         "complexity_rule",
		}
	}
	return routingDecision{}
}

func complexityTierName(c int) string {
	switch {
	case c >= 85:
		return "reasoning"
	case c >= 60:
		return "complex"
	case c >= 30:
		return "standard"
	default:
		return "simple"
	}
}

// rewriteModelField returns body with the top-level "model" field replaced. If the body
// is not valid JSON or has no model, the original body is returned unchanged.
func rewriteModelField(body []byte, model string) []byte {
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return body
	}
	if _, ok := root["model"]; !ok {
		return body
	}
	root["model"] = model
	out, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return out
}
