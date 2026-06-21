package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// skillVisibleToTeam reports whether a production skill is usable by a team (allowed_teams empty
// = any team).
func skillVisibleToTeam(sk store.Skill, team string) bool {
	teams := splitCSV(sk.AllowedTeams)
	if len(teams) == 0 {
		return true
	}
	return containsFold(teams, team)
}

// handleMeSkills lists the production skills available to the caller's team plus skills they can
// request access to, with light adoption/satisfaction stats. GET /me/skills
func (s *Server) handleMeSkills(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	skills, err := s.db.ListSkills(r.Context(), "production")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	stats, _ := s.db.SkillRunStats(r.Context(), time.Now().UTC().AddDate(0, 0, -30))
	statByName := map[string]store.SkillRunStat{}
	for _, st := range stats {
		statByName[st.SkillName] = st
	}
	fb, _ := s.db.SkillFeedbackStats(r.Context())

	available, requestable := []map[string]any{}, []map[string]any{}
	for _, sk := range skills {
		st := statByName[sk.Name]
		successRate := 0.0
		if st.Runs > 0 {
			successRate = float64(st.OK) / float64(st.Runs)
		}
		row := map[string]any{
			"name": sk.Name, "description": sk.Description, "risk_level": sk.RiskLevel,
			"runs_30d": st.Runs, "success_rate": round1(successRate * 100), "users_30d": st.Actors,
			"satisfaction": round1(fb[sk.Name].AvgRating), "feedback_count": fb[sk.Name].Count,
		}
		if skillVisibleToTeam(sk, claims.TeamID) {
			available = append(available, row)
		} else {
			requestable = append(requestable, row)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": available, "requestable": requestable, "team": claims.TeamID})
}

// handleMeSkillAction dispatches POST /me/skills/{name}/request-access and /feedback.
func (s *Server) handleMeSkillAction(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/me/skills/")
	idx := strings.LastIndex(rest, "/")
	if idx < 0 || r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusBadRequest, "expected POST /me/skills/{name}/{action}", "invalid_request_error", "bad_request")
		return
	}
	name, action := rest[:idx], rest[idx+1:]
	if name == "" {
		writeOpenAIError(w, http.StatusBadRequest, "skill name required", "invalid_request_error", "bad_request")
		return
	}
	if _, found, _ := s.db.GetSkill(r.Context(), name); !found {
		writeOpenAIError(w, http.StatusNotFound, "skill not found", "invalid_request_error", "not_found")
		return
	}
	switch action {
	case "request-access":
		var p struct {
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		rq := store.SkillAccessRequest{ID: newID("skreq"), SkillName: name, UserID: claims.Subject, Team: claims.TeamID, Status: "pending", Reason: strings.TrimSpace(p.Reason)}
		if err := s.db.AddSkillAccessRequest(r.Context(), rq); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_failed")
			return
		}
		s.auditAuthEvent(r.Context(), "skill_access_request", claims.Subject, "", claims.TeamID, "skill="+name)
		writeJSON(w, http.StatusCreated, map[string]any{"status": "requested", "skill": name})
	case "feedback":
		var p struct {
			Rating  int    `json:"rating"`
			Comment string `json:"comment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.Rating < 1 || p.Rating > 5 {
			writeOpenAIError(w, http.StatusBadRequest, "rating must be 1..5", "invalid_request_error", "bad_rating")
			return
		}
		fb := store.SkillFeedback{ID: newID("skfb"), SkillName: name, UserID: claims.Subject, Rating: p.Rating, Comment: strings.TrimSpace(p.Comment)}
		if err := s.db.AddSkillFeedback(r.Context(), fb); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "feedback_failed")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"status": "recorded", "skill": name})
	default:
		writeOpenAIError(w, http.StatusNotFound, "unknown action", "invalid_request_error", "not_found")
	}
}

// handleAdminSkillAdoption returns per-skill adoption + satisfaction (admin). GET /admin/skills/adoption
func (s *Server) handleAdminSkillAdoption(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	stats, err := s.db.SkillRunStats(r.Context(), time.Now().UTC().AddDate(0, 0, -30))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "stats_failed")
		return
	}
	fb, _ := s.db.SkillFeedbackStats(r.Context())
	reqs, _ := s.db.ListSkillAccessRequests(r.Context(), "")
	pendingByskill := map[string]int{}
	for _, rq := range reqs {
		if rq.Status == "pending" {
			pendingByskill[rq.SkillName]++
		}
	}
	out := make([]map[string]any, 0, len(stats))
	for _, st := range stats {
		failRate := 0.0
		if st.Runs > 0 {
			failRate = float64(st.Errors+st.Blocked) / float64(st.Runs)
		}
		avgCost := 0.0
		if st.Runs > 0 {
			avgCost = st.TotalCostKRW / float64(st.Runs)
		}
		out = append(out, map[string]any{
			"skill": st.SkillName, "runs_30d": st.Runs, "distinct_users": st.Actors,
			"fail_rate": round1(failRate * 100), "avg_cost_krw": round1(avgCost),
			"satisfaction": round1(fb[st.SkillName].AvgRating), "feedback_count": fb[st.SkillName].Count,
			"pending_access_requests": pendingByskill[st.SkillName], "last_run_at": st.LastRunAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": out, "window_days": 30})
}
