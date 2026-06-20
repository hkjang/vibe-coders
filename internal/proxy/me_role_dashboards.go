package proxy

import (
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// authorizeScope reports whether the caller holds a specific scope (legacy admin-token
// mode passes). Used to gate the role-tailored dashboards independently of /admin/*.
func (s *Server) authorizeScope(r *http.Request, scope string) bool {
	if !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	return ok && hasScope(claims.Scopes, scope)
}

// handleSecurityDashboard is the security_admin landing: policy violations, Secret
// Firewall hits, risky MCP tools, and the pending approval queue. Requires security:read.
// Never exposes prompt originals or cost detail. GET /security/dashboard[?window=]
func (s *Server) handleSecurityDashboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeScope(r, "security:read") {
		writeOpenAIError(w, http.StatusForbidden, "security:read scope required", "invalid_request_error", "forbidden")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	ctx := r.Context()

	// Policy decisions → counts by decision + recent.
	decisions, _ := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{Since: since, Limit: 500})
	byDecision := map[string]int{}
	recentDecisions := make([]map[string]any, 0, 10)
	for _, d := range decisions {
		byDecision[strings.ToLower(d.Decision)]++
		if len(recentDecisions) < 10 && !strings.EqualFold(d.Decision, "allow") {
			recentDecisions = append(recentDecisions, map[string]any{
				"decision": d.Decision, "reason": d.Reason, "rule": d.RuleName,
				"endpoint": d.Endpoint, "risk_score": d.RiskScore, "created_at": d.CreatedAt,
			})
		}
	}

	// Secret firewall detections.
	secrets, _ := s.db.ListSecretEventsFiltered(ctx, store.SecretEventFilter{Since: since, Limit: 500})
	secretByType := map[string]int{}
	for _, e := range secrets {
		secretByType[e.SecretType]++
	}

	// Risky MCP tools (high/critical risk profiles) + overall MCP volume.
	risky := []store.ToolRiskProfile{}
	if profiles, err := s.db.ListToolRiskProfiles(ctx); err == nil {
		for _, p := range profiles {
			if p.RiskLevel == "high" || p.RiskLevel == "critical" {
				risky = append(risky, p)
			}
		}
	}
	mcp, _ := s.db.MCPSummary(ctx)

	// Pending approval queue.
	pending, _ := s.db.ListApprovalsFiltered(ctx, store.ApprovalFilter{Status: "pending", Limit: 50})

	writeJSON(w, http.StatusOK, map[string]any{
		"since": since.UTC().Format(time.RFC3339),
		"policy": map[string]any{
			"by_decision": byDecision,
			"blocked":     byDecision["block"],
			"warned":      byDecision["warn"],
			"recent":      recentDecisions,
		},
		"secrets": map[string]any{
			"total":   len(secrets),
			"by_type": secretByType,
		},
		"risky_tools":      risky,
		"mcp_summary":      mcp,
		"pending_approvals": pending,
		"pending_count":    len(pending),
	})
}

// handleBillingDashboard is the billing_admin landing: cost-center spend, budget burn,
// and model-migration savings. Requires admin:read (org-wide cost view). Never exposes
// prompt originals or security policy. GET /billing/dashboard[?window=]
func (s *Server) handleBillingDashboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeScope(r, "admin:read") {
		writeOpenAIError(w, http.StatusForbidden, "admin:read scope required", "invalid_request_error", "forbidden")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	ctx := r.Context()

	// Cost by cost-center + by model; overall total.
	byCostCenter, _ := s.db.CostAllocation(ctx, "cost_center", since, 20)
	byModel, _ := s.db.CostAllocation(ctx, "model", since, 20)
	var total float64
	var totalReq int64
	for _, row := range byModel {
		total += row.CostKRW
		totalReq += row.Requests
	}

	// Budget burn / forecast.
	budgets, _ := s.db.BudgetStatuses(ctx, time.Now().UTC())

	// Model migration savings candidates.
	migration, _ := s.db.ModelMigrationAdvice(ctx, since, 10, 20)
	var estSavings float64
	for _, m := range migration {
		estSavings += m.EstimatedSavingsKRW
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"since":              since.UTC().Format(time.RFC3339),
		"total_cost_krw":     total,
		"total_requests":     totalReq,
		"by_cost_center":     byCostCenter,
		"by_model":           byModel,
		"budgets":            budgets,
		"migration_candidates": migration,
		"estimated_savings_krw": estSavings,
	})
}
