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
