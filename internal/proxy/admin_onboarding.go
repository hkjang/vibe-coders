package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// AI App onboarding wizard — a pre-publish readiness check so new apps are registered with an
// owner, scoped access, and documentation rather than landing as ungoverned assets (the SBOM's
// gaps, prevented at creation time instead of found later).

type onboardingCheck struct {
	Key      string `json:"key"`
	OK       bool   `json:"ok"`
	Severity string `json:"severity"` // required | recommended
	Detail   string `json:"detail"`
}

// appOnboardingChecklist evaluates a draft app's governance readiness. Pure (no DB) so it is
// trivially testable and reusable from the create form. ready = all required checks pass.
func appOnboardingChecklist(a store.WorkApp) (bool, []onboardingCheck) {
	checks := []onboardingCheck{}
	req := func(ok bool, key, detail string) {
		checks = append(checks, onboardingCheck{Key: key, OK: ok, Severity: "required", Detail: detail})
	}
	rec := func(ok bool, key, detail string) {
		checks = append(checks, onboardingCheck{Key: key, OK: ok, Severity: "recommended", Detail: detail})
	}

	req(strings.TrimSpace(a.Title) != "", "title", "앱 제목이 필요합니다.")
	req(strings.TrimSpace(a.Owner) != "", "owner", "책임자(owner)를 지정해야 운영 책임이 명확해집니다.")
	req(len(a.Components) > 0, "components", "최소 1개 이상의 구성요소가 필요합니다.")
	rec(strings.TrimSpace(a.Description) != "", "description", "설명을 작성하면 사용자가 용도를 이해하기 쉽습니다.")
	scoped := strings.TrimSpace(a.AllowedTeams) != "" || strings.TrimSpace(a.AllowedRoles) != ""
	rec(scoped, "access_scope", "허용 팀/역할을 지정하지 않으면 모든 사용자에게 노출됩니다(명시 권한은 별도).")

	ready := true
	for _, c := range checks {
		if c.Severity == "required" && !c.OK {
			ready = false
		}
	}
	return ready, checks
}

// mcpOnboardingChecklist evaluates a draft MCP upstream's readiness: endpoint, metadata that the
// discovery router and governance need (description, risk level), and a risk-appropriate approval
// gate. Pure (no DB). ready = all required checks pass.
func mcpOnboardingChecklist(u store.MCPUpstream) (bool, []onboardingCheck) {
	checks := []onboardingCheck{}
	req := func(ok bool, key, detail string) {
		checks = append(checks, onboardingCheck{Key: key, OK: ok, Severity: "required", Detail: detail})
	}
	rec := func(ok bool, key, detail string) {
		checks = append(checks, onboardingCheck{Key: key, OK: ok, Severity: "recommended", Detail: detail})
	}

	req(strings.TrimSpace(u.Name) != "", "name", "표시 이름이 필요합니다.")
	req(strings.TrimSpace(u.URL) != "", "url", "MCP 엔드포인트 URL이 필요합니다.")
	rec(strings.TrimSpace(u.Metadata.Description) != "", "description", "설명이 있으면 discovery 라우터가 관련 서버를 더 잘 고릅니다.")
	rec(strings.TrimSpace(u.Metadata.RiskLevel) != "", "risk_level", "위험 등급(low/medium/high/critical)을 지정하세요.")
	// High/critical-risk upstreams should require approval before tool calls.
	risk := strings.ToLower(strings.TrimSpace(u.Metadata.RiskLevel))
	if risk == "high" || risk == "critical" {
		req(u.Metadata.RequiresApproval, "approval_gate", "high/critical 위험 업스트림은 requires_approval=true가 필요합니다.")
	}

	ready := true
	for _, c := range checks {
		if c.Severity == "required" && !c.OK {
			ready = false
		}
	}
	return ready, checks
}

// handleMCPOnboardingCheck validates a draft MCP upstream payload and returns the checklist.
// POST /admin/mcp/onboarding-check {name, url, metadata:{description, risk_level, requires_approval}}
func (s *Server) handleMCPOnboardingCheck(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var u store.MCPUpstream
	if err := json.Unmarshal(body, &u); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON", "invalid_request_error", "bad_request")
		return
	}
	ready, checks := mcpOnboardingChecklist(u)
	missing := 0
	for _, c := range checks {
		if !c.OK {
			missing++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ready":   ready,
		"checks":  checks,
		"missing": missing,
		"note":    "MCP 업스트림 등록 전 준비 점검입니다. high/critical 위험은 승인 게이트가 필수입니다.",
	})
}

// handleAppOnboardingCheck validates a draft AI app payload and returns the readiness checklist.
// POST /admin/apps/onboarding-check {title, owner, description, allowed_teams, allowed_roles, components}
func (s *Server) handleAppOnboardingCheck(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var a store.WorkApp
	if err := json.Unmarshal(body, &a); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON", "invalid_request_error", "bad_request")
		return
	}
	ready, checks := appOnboardingChecklist(a)
	missing := 0
	for _, c := range checks {
		if !c.OK {
			missing++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ready":   ready,
		"checks":  checks,
		"missing": missing,
		"note":    "발행 전 거버넌스 준비 점검입니다. required 항목을 모두 충족해야 ready=true가 됩니다. SBOM 공백을 생성 시점에 예방합니다.",
	})
}
