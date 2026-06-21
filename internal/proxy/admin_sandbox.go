package proxy

import (
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/text2sql"
)

// handleSandboxPreview runs a candidate high-risk request through every read-only safety gate
// WITHOUT executing it (no upstream call, no tool run, no Text2SQL execution, nothing persisted).
// It returns the would-be verdict: policy decision, prompt-injection score, secret detection,
// SQL validation, and MCP tool risk — a safe preview of a sensitive workflow.
// POST /admin/sandbox/preview
func (s *Server) handleSandboxPreview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Kind     string `json:"kind"` // chat | text2sql | mcp
		Model    string `json:"model"`
		Provider string `json:"provider"`
		Team     string `json:"team"`
		Content  string `json:"content"` // prompt / question text (not stored)
		SQL      string `json:"sql"`     // candidate SQL for text2sql (not echoed back)
		Server   string `json:"server"`  // MCP server label
		Tool     string `json:"tool"`    // MCP tool name
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	ctx := r.Context()
	checks := map[string]any{}
	wouldBlock := false
	reasons := []string{}

	// Prompt-injection + secret detection on the content (results only — no raw echo).
	if strings.TrimSpace(p.Content) != "" {
		families, severity := detectPromptInjection(p.Content)
		checks["prompt_injection"] = map[string]any{"families": families, "severity": severity}
		if severity >= 70 {
			wouldBlock = true
			reasons = append(reasons, "프롬프트 인젝션 의심(심각도 "+itoaProxy(severity)+")")
		}
		findings := detectSecretsInText(p.Content)
		types := findingTypes(findings)
		checks["secrets"] = map[string]any{"types": types, "count": len(findings)}
	}

	containsSecret := false
	if sc, ok := checks["secrets"].(map[string]any); ok {
		if n, ok2 := sc["count"].(int); ok2 && n > 0 {
			containsSecret = true
		}
	}

	// Policy decision (replayed read-only against active rules).
	if rules, err := s.db.ActivePolicyRules(ctx); err == nil {
		gctx := governanceContext{
			Model: p.Model, Provider: p.Provider, TeamID: p.Team, Endpoint: "sandbox",
			ContainsSecret: containsSecret,
		}
		d := evaluatePolicyRules(rules, gctx)
		outcome := decisionOutcome(d)
		checks["policy"] = map[string]any{"outcome": outcome, "reason": d.Reason, "secret_action": d.SecretAction}
		if d.Blocked {
			wouldBlock = true
			reasons = append(reasons, "정책 차단")
		}
	}

	// Text2SQL validation (SELECT-only / forbidden / LIMIT) — verdict only, SQL not returned.
	if strings.TrimSpace(p.SQL) != "" {
		res := text2sql.ValidateSQL(p.SQL, text2sql.ValidateOptions{DefaultLimit: 1000, MaxLimit: 10000})
		checks["text2sql_validation"] = map[string]any{
			"ok": res.OK, "reason": res.Reason, "tables": res.Tables, "limit_added": res.LimitAdded,
		}
		if !res.OK {
			wouldBlock = true
			reasons = append(reasons, "SQL 검증 실패: "+res.Reason)
		}
	}

	// MCP tool risk profile.
	if strings.TrimSpace(p.Tool) != "" {
		prof, found, _ := s.db.ToolRiskProfile(ctx, p.Server, p.Tool)
		risk := "unknown"
		action := "allow"
		if found {
			risk = firstNonEmpty(prof.RiskLevel, "low")
			action = firstNonEmpty(prof.Action, "allow")
		}
		checks["mcp_tool_risk"] = map[string]any{"risk_level": risk, "action": action, "profiled": found}
		if action == "block" {
			wouldBlock = true
			reasons = append(reasons, "MCP 도구가 차단 정책 대상")
		}
	}

	s.auditAdmin(r, "sandbox_preview", firstNonEmpty(p.Kind, "chat"), "")
	writeJSON(w, http.StatusOK, map[string]any{
		"kind":        firstNonEmpty(p.Kind, "chat"),
		"would_block": wouldBlock,
		"reasons":     reasons,
		"checks":      checks,
		"note":        "격리 프리뷰입니다. 실제 업스트림 호출·도구 실행·Text2SQL 실행은 일어나지 않으며 입력 원문은 저장되지 않습니다. 안전 게이트 통과 여부만 보여줍니다.",
	})
}
