package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// policySuggestion is a ready-to-apply governance rule the advisor recommends from observed
// signals. Conditions/Actions use the same vocabulary as the policy engine, so applying one
// creates a (disabled) draft policy the admin can review and enable.
type policySuggestion struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Severity   string         `json:"severity"` // critical | warning | info
	Rationale  string         `json:"rationale"`
	Evidence   map[string]any `json:"evidence"`
	Conditions map[string]any `json:"conditions"`
	Actions    map[string]any `json:"actions"`
}

// handlePolicyAdvisorSuggestions analyzes recent signals and recommends governance rules an
// operator likely needs — so they tune policy from evidence instead of inventing it. Read-only;
// skips suggestions already covered by an active rule. GET /admin/policy-advisor/suggestions
func (s *Server) handlePolicyAdvisorSuggestions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")

	active, _ := s.db.ActivePolicyRules(ctx)
	suggestions := []policySuggestion{}

	// 1) Cost spike on a specific model → require approval for that model.
	if anomalies, err := s.db.CostAnomalies(ctx, 7*24*time.Hour, 24*time.Hour, 3); err == nil {
		for _, a := range anomalies {
			if a.Direction != "up" || !strings.EqualFold(a.Scope, "model") || a.ScopeValue == "" {
				continue
			}
			if ruleCoversModel(active, a.ScopeValue) {
				continue
			}
			sev := "warning"
			if a.ZScore >= 5 {
				sev = "critical"
			}
			suggestions = append(suggestions, policySuggestion{
				ID: newID("psug"), Title: "모델 " + a.ScopeValue + " 비용 급증 — 승인 요구",
				Severity:   sev,
				Rationale:  "모델 " + a.ScopeValue + "의 비용이 평소 대비 급증(z=" + ftoa(a.ZScore) + ")했습니다. 승인 게이트로 오남용을 차단하세요.",
				Evidence:   map[string]any{"scope": "model", "z_score": round1(a.ZScore), "recent": round1(a.RecentValue), "baseline": round1(a.BaselineMean)},
				Conditions: map[string]any{"model": a.ScopeValue},
				Actions:    map[string]any{"require_approval": true},
			})
		}
	}

	// 2) Many secret detections still in detect-only mode → recommend blocking secrets.
	if secrets, err := s.db.ListSecretEventsFiltered(ctx, store.SecretEventFilter{Since: since, Limit: 500}); err == nil {
		detectOnly := 0
		for _, e := range secrets {
			if strings.EqualFold(e.Action, "detect") {
				detectOnly++
			}
		}
		if detectOnly >= 10 && !ruleHasSecretBlock(active) {
			suggestions = append(suggestions, policySuggestion{
				ID: newID("psug"), Title: "민감정보 차단 정책 추가",
				Severity:   "critical",
				Rationale:  "최근 " + itoaProxy(detectOnly) + "건의 secret이 탐지(detect)만 되고 차단되지 않았습니다. secret_action=block으로 유출을 막으세요.",
				Evidence:   map[string]any{"detect_only_events": detectOnly},
				Conditions: map[string]any{"contains_secret": true},
				Actions:    map[string]any{"secret_action": "block"},
			})
		}
	}

	// 3) MCP tool error spike → require approval for that tool.
	if tools, err := s.db.ListMCPTools(ctx, store.ToolFilter{MCPOnly: true, Since: since, Limit: 50}); err == nil {
		for _, t := range tools {
			if t.Calls < 20 || t.ErrorRate < 0.2 || t.ToolName == "" {
				continue
			}
			if ruleCoversMCPTool(active, t.ToolName) {
				continue
			}
			suggestions = append(suggestions, policySuggestion{
				ID: newID("psug"), Title: "MCP 도구 " + t.ToolName + " 오류 급증 — 승인 요구",
				Severity:   "warning",
				Rationale:  "MCP 도구 " + t.ToolName + " 오류율이 " + ftoa(t.ErrorRate*100) + "%입니다. 승인 게이트로 위험 호출을 검토하세요.",
				Evidence:   map[string]any{"calls": t.Calls, "error_rate": round1(t.ErrorRate * 100), "server": t.ServerLabel},
				Conditions: map[string]any{"mcp_tool": t.ToolName},
				Actions:    map[string]any{"require_approval": true},
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"window":      since.UTC().Format(time.RFC3339),
		"suggestions": suggestions,
		"note":        "로그 근거로 추천된 정책 규칙입니다. 적용 시 비활성(draft) 정책으로 생성되며, 정책 화면에서 검토 후 활성화하세요. 이미 활성 규칙이 있는 항목은 제외됩니다.",
	})
}

// handlePolicyAdvisorApply creates a DISABLED draft policy from a suggestion's rule so the admin
// reviews and enables it deliberately. POST /admin/policy-advisor/apply {title, conditions, actions}
func (s *Server) handlePolicyAdvisorApply(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Title      string         `json:"title"`
		Conditions map[string]any `json:"conditions"`
		Actions    map[string]any `json:"actions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if len(p.Actions) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "actions are required", "invalid_request_error", "no_actions")
		return
	}
	title := firstNonEmpty(strings.TrimSpace(p.Title), "advisor 추천 정책")
	policyID := newID("pol")
	policy := store.Policy{
		ID: policyID, Name: "[draft] " + title, Description: "Policy Advisor 추천 (검토 후 활성화)",
		Enabled: false, Priority: 100,
	}
	rule := store.PolicyRule{
		ID: newID("prule"), PolicyID: policyID, Name: title, Enabled: true, Priority: 100,
		Conditions: p.Conditions, Actions: p.Actions,
	}
	if err := s.db.UpsertPolicyWithRules(r.Context(), policy, []store.PolicyRule{rule}); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policy_save_failed")
		return
	}
	s.auditAdmin(r, "policy_advisor.apply", "", auditJSON(map[string]any{"policy_id": policyID, "title": title, "conditions": p.Conditions, "actions": p.Actions}))
	writeJSON(w, http.StatusCreated, map[string]any{"policy_id": policyID, "enabled": false, "note": "비활성 draft 정책으로 생성됨 — 정책 화면에서 검토 후 활성화하세요."})
}

// ruleCoversModel reports whether an active rule already targets the given model (deny/allow/
// require_approval scoped to it) — to avoid recommending a duplicate.
func ruleCoversModel(rules []store.PolicyRule, model string) bool {
	for _, r := range rules {
		if m, ok := r.Conditions["model"]; ok && strings.EqualFold(toStr(m), model) {
			return true
		}
		if denied := valueStringList(r.Actions["deny_models"]); listMatchesAny(model, denied) {
			return true
		}
	}
	return false
}

func ruleCoversMCPTool(rules []store.PolicyRule, tool string) bool {
	for _, r := range rules {
		if m, ok := r.Conditions["mcp_tool"]; ok && strings.EqualFold(toStr(m), tool) {
			return true
		}
	}
	return false
}

func ruleHasSecretBlock(rules []store.PolicyRule) bool {
	for _, r := range rules {
		if strings.EqualFold(lowerString(r.Actions["secret_action"]), "block") {
			return true
		}
	}
	return false
}

func toStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
