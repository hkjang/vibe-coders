package proxy

import (
	"net/http"
	"strings"
	"time"
)

// handleTeamPortal is the consolidated team self-service portal: one read-only view a team
// lead can open without admin rights, aggregating the team's OWN usage, budget burn, API keys
// (no secrets — public projection only), accessible skills, pending skill access requests, and
// member roster. team:read gated; admins may inspect any team via ?team=.
// GET /team/portal[?window=]
func (s *Server) handleTeamPortal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teamID, keys, ok := s.resolveTeamScope(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")

	// Usage summary (totals + top users double as member activity).
	dash, err := s.db.TeamDashboardSince(ctx, keys, since, 10)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "team_portal_failed")
		return
	}

	// Budget status: only this team's budgets.
	budgets := []map[string]any{}
	if statuses, err := s.db.BudgetStatuses(ctx, time.Now().UTC()); err == nil {
		for _, st := range statuses {
			if !strings.EqualFold(st.Budget.Scope, "team") || !containsFold(keys, st.Budget.ScopeValue) {
				continue
			}
			budgets = append(budgets, map[string]any{
				"monthly_krw": st.Budget.MonthlyKRW, "spent_krw": round1(st.SpentKRW),
				"burn_ratio": round1(st.BurnRatio), "projected_krw": round1(st.ProjectedKRW),
				"projected_ratio": round1(st.ProjectedRatio), "on_track": st.OnTrack,
				"exhaustion_date": st.ExhaustionDate, "note": st.Budget.Note,
			})
		}
	}

	// API keys belonging to the team (public projection — never includes the secret).
	apiKeys := []map[string]any{}
	memberSet := map[string]bool{}
	if all, err := s.db.ListAPIKeys(ctx); err == nil {
		for _, k := range all {
			if !containsFold(keys, k.Team) {
				continue
			}
			apiKeys = append(apiKeys, map[string]any{
				"id": k.ID, "name": k.Name, "owner": k.Owner, "user_id": k.UserID,
				"role": k.Role, "status": k.Status, "expires_at": k.ExpiresAt,
				"budget_limit_krw": k.BudgetLimitKRW,
			})
			if id := firstNonEmpty(k.UserID, k.Owner); id != "" {
				memberSet[id] = true
			}
		}
	}
	for _, u := range dash.TopUsers {
		if u.UserID != "" {
			memberSet[u.UserID] = true
		}
	}
	members := make([]string, 0, len(memberSet))
	for m := range memberSet {
		members = append(members, m)
	}

	// Skills this team can use (production, visible to the team) + pending access requests.
	accessibleSkills := []map[string]any{}
	if skills, err := s.db.ListSkills(ctx, "production"); err == nil {
		for _, sk := range skills {
			if !skillVisibleToTeam(sk, teamID) {
				continue
			}
			accessibleSkills = append(accessibleSkills, map[string]any{
				"name": sk.Name, "description": sk.Description, "version": sk.Version, "risk_level": sk.RiskLevel,
			})
		}
	}
	pendingRequests := []map[string]any{}
	if reqs, err := s.db.ListSkillAccessRequests(ctx, ""); err == nil {
		for _, rq := range reqs {
			if !strings.EqualFold(rq.Team, teamID) || !strings.EqualFold(rq.Status, "pending") {
				continue
			}
			pendingRequests = append(pendingRequests, map[string]any{
				"id": rq.ID, "skill_name": rq.SkillName, "user_id": rq.UserID,
				"reason": rq.Reason, "created_at": rq.CreatedAt,
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"team_id": teamID,
		"since":   since.UTC().Format(time.RFC3339),
		"usage": map[string]any{
			"requests": dash.Totals.Requests, "cost_krw": round1(dash.Totals.CostKRW),
			"errors": dash.Totals.Errors, "success_rate": round1(dash.Totals.SuccessRate),
			"avg_latency_ms": dash.Totals.AvgLatencyMS,
		},
		"budgets":           budgets,
		"api_keys":          apiKeys,
		"api_key_count":     len(apiKeys),
		"members":           members,
		"member_count":      len(members),
		"accessible_skills": accessibleSkills,
		"skill_count":       len(accessibleSkills),
		"pending_skill_requests": pendingRequests,
		"note": "팀 셀프서비스 포털입니다. team:read 권한으로 본인 팀 데이터만 조회되며, API 키 비밀값은 노출되지 않습니다.",
	})
}
