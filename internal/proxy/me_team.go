package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleTeamDashboard returns the caller's team usage/cost/failures — the team_manager
// landing. Requires the team:read scope; an admin (admin:read) may inspect any team via
// ?team=. Data is scoped to the caller's team only (no cross-team leakage).
// GET /team/dashboard[?window=&team=]
func (s *Server) handleTeamDashboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var teamID string
	if s.cfg.Auth.Enabled {
		claims, ok := s.currentAccessClaims(r)
		if !ok {
			writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
			return
		}
		if !hasScope(claims.Scopes, "team:read") {
			writeOpenAIError(w, http.StatusForbidden, "team:read scope required", "invalid_request_error", "forbidden")
			return
		}
		teamID = claims.TeamID
		// Admins may inspect any team for support/oversight.
		if override := strings.TrimSpace(r.URL.Query().Get("team")); override != "" && hasScope(claims.Scopes, "admin:read") {
			teamID = override
		}
	} else {
		// Legacy admin-token mode: no JWT team; require an explicit ?team=.
		teamID = strings.TrimSpace(r.URL.Query().Get("team"))
	}
	if teamID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no team associated with the caller", "invalid_request_error", "no_team")
		return
	}

	// A team is stored on api_keys.team as either its id or name — match both.
	keys := []string{teamID}
	if team, found, _ := s.db.AuthTeamByIDOrName(r.Context(), teamID); found {
		keys = uniqueNonEmpty(teamID, team.ID, team.Name)
	}

	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	data, err := s.db.TeamDashboardSince(r.Context(), keys, since, 10)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_dashboard_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"team_id":   teamID,
		"since":     since.UTC().Format(time.RFC3339),
		"dashboard": data,
	})
}

// resolveTeamScope authorizes a team-scoped request and returns the team identifiers to
// match (id + name). Requires team:read; admins may target any team via ?team=. Writes the
// HTTP error itself and returns ok=false on failure.
func (s *Server) resolveTeamScope(w http.ResponseWriter, r *http.Request) (teamID string, keys []string, ok bool) {
	if s.cfg.Auth.Enabled {
		claims, authed := s.currentAccessClaims(r)
		if !authed {
			writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
			return "", nil, false
		}
		if !hasScope(claims.Scopes, "team:read") {
			writeOpenAIError(w, http.StatusForbidden, "team:read scope required", "invalid_request_error", "forbidden")
			return "", nil, false
		}
		teamID = claims.TeamID
		if override := strings.TrimSpace(r.URL.Query().Get("team")); override != "" && hasScope(claims.Scopes, "admin:read") {
			teamID = override
		}
	} else {
		teamID = strings.TrimSpace(r.URL.Query().Get("team"))
	}
	if teamID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no team associated with the caller", "invalid_request_error", "no_team")
		return "", nil, false
	}
	keys = []string{teamID}
	if team, found, _ := s.db.AuthTeamByIDOrName(r.Context(), teamID); found {
		keys = uniqueNonEmpty(teamID, team.ID, team.Name)
	}
	return teamID, keys, true
}

// handleTeamPopularSkills lists the team's most-used skills (usage, success, cost) — the
// team-sharing surface for skill adoption. GET /team/skills/popular[?window=]
func (s *Server) handleTeamPopularSkills(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, keys, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	skills, err := s.db.TeamPopularSkills(r.Context(), keys, since, 10)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_skills_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"team_id": teamID, "since": since.UTC().Format(time.RFC3339), "skills": skills})
}

// handleTeamTemplateCandidates proposes recurring team prompt clusters as team templates,
// flagging ones already productized. GET /team/templates/candidates[?window=&min_count=]
func (s *Server) handleTeamTemplateCandidates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, keys, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := intQuery(r, "min_count", 3)
	cands, err := s.db.TeamTemplateCandidates(r.Context(), keys, since, minCount, 15)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_template_candidates_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"team_id": teamID, "since": since.UTC().Format(time.RFC3339), "candidates": cands})
}

// handleTeamRisk surfaces the team's risk posture: policy violations, Secret Firewall
// hits, pending approvals, and the blocked-request trend vs the prior window. Reuses the
// governance filters (whose team_id is the canonical team id, matching claims.TeamID).
// GET /team/risk[?window=]
func (s *Server) handleTeamRisk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, _, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	window := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	now := time.Now().UTC()
	prior := window.Add(-now.Sub(window)) // equal-length window immediately before `window`
	ctx := r.Context()

	countBlocked := func(events []store.PolicyDecisionEvent) (blocked, warned int) {
		for _, e := range events {
			switch strings.ToLower(e.Decision) {
			case "block":
				blocked++
			case "warn":
				warned++
			}
		}
		return
	}

	cur, _ := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{TeamID: teamID, Since: window, Limit: 5000})
	wide, _ := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{TeamID: teamID, Since: prior, Limit: 5000})
	curBlocked, curWarned := countBlocked(cur)
	wideBlocked, _ := countBlocked(wide)
	priorBlocked := wideBlocked - curBlocked
	if priorBlocked < 0 {
		priorBlocked = 0
	}

	secrets, _ := s.db.ListSecretEventsFiltered(ctx, store.SecretEventFilter{TeamID: teamID, Since: window, Limit: 5000})
	secretByType := map[string]int{}
	for _, e := range secrets {
		secretByType[e.SecretType]++
	}

	pending, _ := s.db.ListApprovalsFiltered(ctx, store.ApprovalFilter{TeamID: teamID, Status: "pending", Limit: 100})

	recent := make([]map[string]any, 0, 10)
	for _, e := range cur {
		if strings.EqualFold(e.Decision, "allow") {
			continue
		}
		if len(recent) >= 10 {
			break
		}
		recent = append(recent, map[string]any{
			"decision": e.Decision, "reason": e.Reason, "rule": e.RuleName,
			"endpoint": e.Endpoint, "risk_score": e.RiskScore, "created_at": e.CreatedAt,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"team_id":              teamID,
		"since":                window.UTC().Format(time.RFC3339),
		"blocked":              curBlocked,
		"warned":               curWarned,
		"blocked_prior_window": priorBlocked,
		"blocked_trend":        curBlocked - priorBlocked, // >0 = rising risk
		"secrets_total":        len(secrets),
		"secrets_by_type":      secretByType,
		"pending_approvals":    len(pending),
		"recent_violations":    recent,
	})
}

// handleTeamOnboarding assembles a team onboarding pack: the models, skills, and MCP tools
// the team actually relies on — a ready-made starting kit for a new member. Derived from
// team usage (model mix), team skill adoption, and team MCP affinity. GET /team/onboarding
func (s *Server) handleTeamOnboarding(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, keys, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 90*24*time.Hour, "day")
	ctx := r.Context()

	// Recommended models: the team's top models by usage (with success/cost).
	dash, _ := s.db.TeamDashboardSince(ctx, keys, since, 5)
	models := dash.Models
	if len(models) > 5 {
		models = models[:5]
	}

	// Recommended skills: the team's adopted skills, success-weighted.
	skills, _ := s.db.TeamPopularSkills(ctx, keys, since, 5)

	// Recommended MCP tools: the team's most-used MCP tools.
	tools, _ := s.db.TeamMCPTools(ctx, keys, since, 5)

	writeJSON(w, http.StatusOK, map[string]any{
		"team_id":            teamID,
		"since":              since.UTC().Format(time.RFC3339),
		"recommended_models": models,
		"recommended_skills": skills,
		"recommended_mcp":    tools,
		"note":               "팀이 실제로 사용하는 모델·Skill·MCP 도구 묶음입니다. 신규 팀원의 시작 키트로 활용하세요.",
	})
}

// handleTeamSavingsChallenge gamifies team cost discipline: month-to-date spend, a linear
// month-end projection, last month's total, and the projected savings vs last month (the
// "challenge"). All from real team cost — no fabricated projections. GET /team/savings-challenge
func (s *Server) handleTeamSavingsChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, keys, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	lastMonthStart := monthStart.AddDate(0, -1, 0)
	daysInMonth := time.Date(now.Year(), now.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	daysElapsed := now.Day()
	ctx := r.Context()

	mtd, err := s.db.TeamDashboardSince(ctx, keys, monthStart, 1)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_savings_failed")
		return
	}
	sinceLast, err := s.db.TeamDashboardSince(ctx, keys, lastMonthStart, 1)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_savings_failed")
		return
	}
	thisMTD := mtd.Totals.CostKRW
	lastMonthTotal := sinceLast.Totals.CostKRW - thisMTD
	if lastMonthTotal < 0 {
		lastMonthTotal = 0
	}
	projectedMonthEnd := thisMTD
	if daysElapsed > 0 {
		projectedMonthEnd = thisMTD / float64(daysElapsed) * float64(daysInMonth)
	}
	projectedSavings := lastMonthTotal - projectedMonthEnd
	if projectedSavings < 0 {
		projectedSavings = 0
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"team_id":                 teamID,
		"month_to_date_krw":       thisMTD,
		"projected_month_end_krw": projectedMonthEnd,
		"last_month_krw":          lastMonthTotal,
		"projected_savings_krw":   projectedSavings,
		"on_track":                projectedMonthEnd <= lastMonthTotal || lastMonthTotal == 0,
		"days_elapsed":            daysElapsed,
		"days_in_month":           daysInMonth,
	})
}

// handleSubmitReportToTeam lets a saved-report owner submit it for team sharing (→ pending
// approval, tagged with the owner's team). POST /me/reports/submit-to-team {report_id}
func (s *Server) handleSubmitReportToTeam(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	var p struct {
		ReportID string `json:"report_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	rep, found, err := s.db.GetText2SQLSavedReport(r.Context(), strings.TrimSpace(p.ReportID))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "report not found", "invalid_request_error", "not_found")
		return
	}
	// Only the owner may submit their own report (created_by must match the caller).
	if strings.TrimSpace(rep.CreatedBy) != "" && rep.CreatedBy != userID {
		writeOpenAIError(w, http.StatusForbidden, "only the report owner may submit it", "invalid_request_error", "forbidden")
		return
	}
	team := ""
	if claims, ok := s.currentAccessClaims(r); ok {
		team = claims.TeamID
	}
	if team == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no team associated with the caller", "invalid_request_error", "no_team")
		return
	}
	if err := s.db.SubmitReportForTeam(r.Context(), rep.ID, team); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_submit_failed")
		return
	}
	s.notifyMattermost(r.Context(), "approval", "팀 리포트 공유 요청: '"+rep.Name+"' (team "+team+", 제출자 "+userID+")")
	writeJSON(w, http.StatusOK, map[string]any{"report_id": rep.ID, "team": team, "approval_status": "pending"})
}

// handleTeamReports lists a team's shared + pending reports (GET) and decides a pending one
// (POST {report_id, action: approve|reject}). team:read gated.
// GET|POST /team/reports
func (s *Server) handleTeamReports(w http.ResponseWriter, r *http.Request) {
	teamID, _, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		reports, err := s.db.ListTeamReports(r.Context(), teamID)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_reports_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"team_id": teamID, "reports": reports})
	case http.MethodPost:
		var p struct {
			ReportID string `json:"report_id"`
			Action   string `json:"action"` // approve | reject
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		rep, found, err := s.db.GetText2SQLSavedReport(r.Context(), strings.TrimSpace(p.ReportID))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_lookup_failed")
			return
		}
		// Can only decide a report submitted to the caller's own team.
		if !found || rep.Team != teamID {
			writeOpenAIError(w, http.StatusNotFound, "report not found for this team", "invalid_request_error", "not_found")
			return
		}
		approve := strings.EqualFold(strings.TrimSpace(p.Action), "approve")
		if err := s.db.DecideTeamReport(r.Context(), rep.ID, approve, s.skillActor(r)); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_decision_failed")
			return
		}
		status := "rejected"
		if approve {
			status = "approved"
		}
		s.auditAdmin(r, "team_report."+status, rep.ID, auditJSON(map[string]any{"team": teamID}))
		writeJSON(w, http.StatusOK, map[string]any{"report_id": rep.ID, "approval_status": status})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func uniqueNonEmpty(values ...string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}
