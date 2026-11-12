package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
)

func (s *Server) handleAuthTeamPage(w http.ResponseWriter, r *http.Request) {
	invalid := func() {
		writeOpenAIError(w, http.StatusBadRequest, "invalid registered team page filters", "invalid_request_error", "invalid_team_query")
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		invalid()
		return
	}
	for _, key := range []string{"view", "q", "id", "sort", "limit", "offset"} {
		if len(values[key]) > 1 {
			invalid()
			return
		}
	}
	query := store.AuthTeamQuery{Search: values.Get("q"), Limit: 25}
	if values.Has("id") {
		id := values.Get("id")
		query.ID = &id
	}
	for _, item := range []struct {
		key    string
		target *int
	}{{"limit", &query.Limit}, {"offset", &query.Offset}} {
		if values.Has(item.key) {
			value, err := strconv.Atoi(values.Get(item.key))
			if err != nil {
				invalid()
				return
			}
			*item.target = value
		}
	}
	claims, authenticated := s.currentAccessClaims(r)
	if s.cfg.Auth.Enabled && !authenticated {
		// A session can expire or be revoked after the outer authorization.
		// Missing identity must not remove the authenticated team restriction.
		writeOpenAIError(w, http.StatusUnauthorized, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	if authenticated && claims.Role == "team_admin" {
		team := claims.TeamID
		query.ScopeTeam = &team
	}
	if values.Has("sort") {
		for _, item := range strings.Split(values.Get("sort"), ",") {
			field, direction, found := strings.Cut(item, ":")
			if !found || (direction != "asc" && direction != "desc") {
				invalid()
				return
			}
			query.Sort = append(query.Sort, store.AuthTeamSort{Field: field, Desc: direction == "desc"})
		}
	}
	page, err := s.db.ListAuthTeamPage(r.Context(), query)
	if errors.Is(err, store.ErrInvalidAuthTeamQuery) {
		invalid()
		return
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to load registered teams", "server_error", "teams_failed")
		return
	}
	writeJSON(w, http.StatusOK, page)
}
