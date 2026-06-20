package proxy

import (
	"net/http"
	"strings"
	"time"
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
