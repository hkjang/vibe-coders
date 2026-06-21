package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handlePolicyRegressionCases manages the policy regression test suite.
// GET    /admin/policies/regression/cases        list cases (?enabled=1 to filter)
// POST   /admin/policies/regression/cases        upsert a case
// DELETE /admin/policies/regression/cases?id=..  delete a case
func (s *Server) handlePolicyRegressionCases(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		cases, err := s.db.ListPolicyRegressionCases(ctx, r.URL.Query().Get("enabled") == "1")
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"cases": regressionCasesJSON(cases)})
	case http.MethodPost:
		var p struct {
			ID                 string   `json:"id"`
			Name               string   `json:"name"`
			Description        string   `json:"description"`
			Model              string   `json:"model"`
			Provider           string   `json:"provider"`
			TeamID             string   `json:"team_id"`
			Role               string   `json:"role"`
			Endpoint           string   `json:"endpoint"`
			ComplexityScore    int      `json:"complexity_score"`
			RiskScore          int      `json:"risk_score"`
			ContainsSecret     bool     `json:"contains_secret"`
			SecretTypes        []string `json:"secret_types"`
			MCPServer          string   `json:"mcp_server"`
			MCPTool            string   `json:"mcp_tool"`
			Expect             string   `json:"expect"`
			ExpectSecretAction string   `json:"expect_secret_action"`
			Enabled            *bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		expect := strings.ToLower(strings.TrimSpace(p.Expect))
		switch expect {
		case "allow", "block", "require_approval":
		case "":
			expect = "allow"
		default:
			writeOpenAIError(w, http.StatusBadRequest, "expect must be allow|block|require_approval", "invalid_request_error", "bad_expect")
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "no_name")
			return
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		c := store.PolicyRegressionCase{
			ID: firstNonEmpty(strings.TrimSpace(p.ID), newID("preg")), Name: strings.TrimSpace(p.Name),
			Description: p.Description, Model: p.Model, Provider: p.Provider, TeamID: p.TeamID, Role: p.Role,
			Endpoint: p.Endpoint, ComplexityScore: p.ComplexityScore, RiskScore: p.RiskScore,
			ContainsSecret: p.ContainsSecret, SecretTypes: p.SecretTypes, MCPServer: p.MCPServer, MCPTool: p.MCPTool,
			Expect: expect, ExpectSecretAction: strings.ToLower(strings.TrimSpace(p.ExpectSecretAction)),
			Enabled: enabled, CreatedBy: adminID(r),
		}
		if err := s.db.UpsertPolicyRegressionCase(ctx, c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "upsert_failed")
			return
		}
		s.auditAdmin(r, "policy_regression_case_upsert", "", auditJSON(map[string]any{"id": c.ID, "name": c.Name, "expect": c.Expect}))
		writeJSON(w, http.StatusOK, map[string]any{"id": c.ID, "ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param required", "invalid_request_error", "no_id")
			return
		}
		if err := s.db.DeletePolicyRegressionCase(ctx, id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "policy_regression_case_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handlePolicyRegressionRun replays all enabled regression cases against a rule set and reports
// which cases pass/fail. Rules come from (in priority order): inline rules[], a policy_id's active
// rules, or — by default — ALL currently active policy rules. This detects when a policy change
// flips a previously-locked decision.
// POST /admin/policies/regression/run
func (s *Server) handlePolicyRegressionRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	ctx := r.Context()
	var p struct {
		Rules []struct {
			Name       string         `json:"name"`
			Conditions map[string]any `json:"conditions"`
			Actions    map[string]any `json:"actions"`
		} `json:"rules"`
		PolicyID string `json:"policy_id"`
	}
	// Body is optional; default = active rules.
	_ = json.NewDecoder(r.Body).Decode(&p)

	rules := make([]store.PolicyRule, 0, len(p.Rules))
	source := "active"
	for i, rr := range p.Rules {
		rules = append(rules, store.PolicyRule{
			ID: "sim-" + itoaProxy(i), Name: firstNonEmpty(rr.Name, "sim-rule-"+itoaProxy(i)),
			Conditions: rr.Conditions, Actions: rr.Actions,
		})
	}
	if len(rules) > 0 {
		source = "inline"
	} else {
		all, err := s.db.ActivePolicyRules(ctx)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rules_failed")
			return
		}
		if pid := strings.TrimSpace(p.PolicyID); pid != "" {
			source = "policy:" + pid
			for _, rule := range all {
				if rule.PolicyID == pid {
					rules = append(rules, rule)
				}
			}
		} else {
			rules = all
		}
	}

	cases, err := s.db.ListPolicyRegressionCases(ctx, true)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}

	results := make([]map[string]any, 0, len(cases))
	passed, failed := 0, 0
	for _, c := range cases {
		gctx := governanceContext{
			Model: c.Model, Provider: c.Provider, TeamID: c.TeamID, Role: c.Role, Endpoint: c.Endpoint,
			ComplexityScore: c.ComplexityScore, RiskScore: c.RiskScore,
			ContainsSecret: c.ContainsSecret, SecretTypes: c.SecretTypes, MCPServer: c.MCPServer, MCPTool: c.MCPTool,
		}
		d := evaluatePolicyRules(rules, gctx)
		actual := decisionOutcome(d)
		actualSecret := firstNonEmpty(d.SecretAction, "detect")
		ok := actual == c.Expect
		// Only check secret action when the case expects a specific one.
		if c.ExpectSecretAction != "" && c.ExpectSecretAction != actualSecret {
			ok = false
		}
		if ok {
			passed++
		} else {
			failed++
		}
		results = append(results, map[string]any{
			"id": c.ID, "name": c.Name, "expect": c.Expect, "actual": actual,
			"expect_secret_action": c.ExpectSecretAction, "actual_secret_action": actualSecret,
			"pass": ok, "reason": d.Reason,
		})
	}

	s.auditAdmin(r, "policy_regression_run", source, auditJSON(map[string]any{"total": len(cases), "passed": passed, "failed": failed}))
	writeJSON(w, http.StatusOK, map[string]any{
		"rule_source": source,
		"rule_count":  len(rules),
		"total":       len(cases),
		"passed":      passed,
		"failed":      failed,
		"results":     results,
		"ran_at":      time.Now().UTC().Format(time.RFC3339),
		"note":        "고정 입력 시나리오를 정책 규칙에 재생하여 기대 결과(allow/block/require_approval)와 비교합니다. 원문 prompt/SQL은 저장하지 않습니다.",
	})
}

// decisionOutcome maps a governance decision to the regression outcome vocabulary.
func decisionOutcome(d governanceDecision) string {
	switch {
	case d.Blocked:
		return "block"
	case d.RequireApproval:
		return "require_approval"
	default:
		return "allow"
	}
}

func regressionCasesJSON(cases []store.PolicyRegressionCase) []map[string]any {
	out := make([]map[string]any, 0, len(cases))
	for _, c := range cases {
		out = append(out, map[string]any{
			"id": c.ID, "name": c.Name, "description": c.Description,
			"model": c.Model, "provider": c.Provider, "team_id": c.TeamID, "role": c.Role, "endpoint": c.Endpoint,
			"complexity_score": c.ComplexityScore, "risk_score": c.RiskScore,
			"contains_secret": c.ContainsSecret, "secret_types": c.SecretTypes,
			"mcp_server": c.MCPServer, "mcp_tool": c.MCPTool,
			"expect": c.Expect, "expect_secret_action": c.ExpectSecretAction,
			"enabled": c.Enabled, "created_by": c.CreatedBy, "updated_at": c.UpdatedAt,
		})
	}
	return out
}
