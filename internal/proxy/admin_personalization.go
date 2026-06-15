package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handlePersonalProfiles lists per-user AI profiles for the most active users over a
// window (computed live). Read-only.
// GET /admin/personalization/profiles?window=30d&limit=25
func (s *Server) handlePersonalProfiles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profiles_failed")
		return
	}
	profiles := make([]store.PersonalProfile, 0, len(users))
	for _, uid := range users {
		p, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profiles_failed")
			return
		}
		profiles = append(profiles, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": profiles})
}

// handlePersonalProfileDetail computes one user's profile live, caches it as the latest
// stored profile, and (with ?snapshot=1) records a point-in-time snapshot. Returns the
// profile plus the user's snapshot history.
// GET /admin/personalization/profiles/{user_id}?window=30d&snapshot=1
func (s *Server) handlePersonalProfileDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	userID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/personalization/profiles/"), "/")
	if userID == "" {
		s.handlePersonalProfiles(w, r)
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	p, err := s.db.BuildPersonalProfile(r.Context(), userID, since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	// Cache the latest profile; best-effort.
	_ = s.db.UpsertPersonalProfile(r.Context(), userID, string(encoded))
	if strings.TrimSpace(r.URL.Query().Get("snapshot")) == "1" {
		if err := s.db.InsertPersonalProfileSnapshot(r.Context(), newID("pps"), userID, string(encoded)); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "snapshot_failed")
			return
		}
		s.auditAdmin(r, "personalization.profile.snapshot", userID, "")
	}
	snapshots, err := s.db.ListPersonalProfileSnapshots(r.Context(), userID, 20)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": p, "snapshots": snapshots})
}
