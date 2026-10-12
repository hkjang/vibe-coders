package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var resourceSearchFeatures = map[string]string{
	"provider": "gateway.providers", "workflow": "agents.workflows",
	"app": "agents.apps", "skill": "agents.skills",
}

type resourceSearchItem struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Title string `json:"title"`
}

type resourceSearchGroup struct {
	Kind    string               `json:"kind"`
	Items   []resourceSearchItem `json:"items"`
	Limited bool                 `json:"limited"`
	Status  string               `json:"status"`
}

// Search is a read-only POST so search text never enters the URL or access logs.
// Reuse bootstrap identity and feature resolution, then the existing admin
// authorization path with read semantics. No write scope is inferred.
func (s *Server) handleAdminResourceSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil {
		writeOpenAIError(w, 401, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	if !hasScope(user.Scopes, "admin:read") {
		writeOpenAIError(w, 403, "resource search permission required", "invalid_request_error", "permission_denied")
		return
	}
	// Only the authorization view uses GET semantics: search is read-only even
	// though its input belongs in a POST body. Keep the real request unchanged.
	// This also rejects upstream RS256 tokens that bootstrap accepts but admin
	// lists do not: SSO users must first exchange them for a gateway session.
	readRequest := r.Clone(r.Context())
	readRequest.Method = http.MethodGet
	if !s.authorizeAdmin(readRequest) {
		writeOpenAIError(w, 401, "authentication required", "invalid_request_error", "invalid_access_token")
		return
	}
	var input struct {
		Query string   `json:"query"`
		Kinds []string `json:"kinds"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if r.URL.RawQuery != "" || decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeOpenAIError(w, 400, "invalid search request", "invalid_request_error", "invalid_search")
		return
	}
	input.Query = strings.TrimSpace(input.Query)
	if !utf8.ValidString(input.Query) || utf8.RuneCountInString(input.Query) < 2 || utf8.RuneCountInString(input.Query) > 128 || !s.safeResourceSearchText(input.Query) || len(input.Kinds) < 1 || len(input.Kinds) > 4 {
		writeOpenAIError(w, 400, "invalid search request", "invalid_request_error", "invalid_search")
		return
	}
	seen := map[string]bool{}
	for _, kind := range input.Kinds {
		if resourceSearchFeatures[kind] == "" || seen[kind] {
			writeOpenAIError(w, 400, "invalid search kinds", "invalid_request_error", "invalid_search")
			return
		}
		seen[kind] = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	stored, err := s.loadStoredSettings(r.WithContext(ctx))
	if err != nil {
		writeOpenAIError(w, 503, "search is unavailable", "server_error", "search_unavailable")
		return
	}
	allowed := map[string]bool{}
	for _, feature := range effectiveAppUIFeatures(stored, s, user.ID, user.Role, user.Scopes, true) {
		allowed[feature.FeatureID] = feature.Available && feature.Status != "legacy" && feature.Status != "hidden"
	}
	groups := make([]resourceSearchGroup, 0, len(input.Kinds))
	providerRef := s.providerRefSnapshot()
	for _, kind := range input.Kinds {
		group := resourceSearchGroup{Kind: kind, Items: []resourceSearchItem{}, Status: "forbidden"}
		if allowed[resourceSearchFeatures[kind]] {
			rows, more, err := s.db.SearchResourceMetadata(ctx, kind, input.Query, 10)
			group.Status = "ok"
			if err != nil {
				group.Status = "unavailable"
			} else {
				group.Limited = more
				for _, row := range rows {
					if kind == "provider" && !s.modelsProviderLabelSafeForConfig(row.Title) {
						continue
					}
					// Omit, rather than truncate or partially reveal, unsafe names/IDs.
					// Check even for raw-prompt privileged administrators.
					if !s.safeResourceSearchText(row.ID) || !s.safeResourceSearchText(row.Title) {
						continue
					}
					id := row.ID
					if kind == "provider" {
						id = providerRef(row.ID)
					}
					group.Items = append(group.Items, resourceSearchItem{Kind: kind, ID: id, Title: row.Title})
				}
			}
		}
		groups = append(groups, group)
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups, "request_id": traceIDFromRequest(r)})
}

func (s *Server) safeResourceSearchText(value string) bool {
	return value != "" && len(value) <= 2048 && utf8.ValidString(value) &&
		strings.TrimSpace(value) == value && strings.IndexFunc(value, unicode.IsControl) < 0 &&
		!providerURLComponentHasCredential(value) && !providerLabelContainsSensitivePII(value) &&
		boundedExternalProviderText(value, s.externalCredentialProjectionArgs()...) == value
}
