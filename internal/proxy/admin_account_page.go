package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
)

func (s *Server) handleAuthAccountPage(w http.ResponseWriter, r *http.Request) {
	invalid := func() {
		writeOpenAIError(w, http.StatusBadRequest, "invalid account page filters", "invalid_request_error", "invalid_account_query")
	}
	values, parseErr := url.ParseQuery(r.URL.RawQuery)
	if parseErr != nil {
		invalid()
		return
	}
	for _, key := range []string{"view", "id", "limit", "offset", "q", "role", "status", "team_id", "sort"} {
		if len(values[key]) > 1 {
			invalid()
			return
		}
	}
	query := store.AuthAccountQuery{Search: values.Get("q"), Role: values.Get("role"), Status: values.Get("status"), Limit: 25}
	if values.Has("id") {
		id := values.Get("id")
		query.ID = &id
	}
	for _, item := range []struct {
		key    string
		target *int
	}{{"limit", &query.Limit}, {"offset", &query.Offset}} {
		if values.Has(item.key) {
			parsed, err := strconv.Atoi(values.Get(item.key))
			if err != nil {
				invalid()
				return
			}
			*item.target = parsed
		}
	}
	if values.Has("team_id") {
		team := values.Get("team_id")
		query.Team = &team
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
			query.Sort = append(query.Sort, store.AuthAccountSort{Field: field, Desc: direction == "desc"})
		}
	}
	page, err := s.db.ListAuthAccountPage(r.Context(), query)
	if errors.Is(err, store.ErrInvalidAuthAccountQuery) {
		invalid()
		return
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to load login accounts", "server_error", "accounts_failed")
		return
	}
	writeJSON(w, http.StatusOK, page)
}
