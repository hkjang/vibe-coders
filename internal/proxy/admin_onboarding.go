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
