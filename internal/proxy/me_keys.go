package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// meIdentity is the resolved calling user with the role/scopes that cap what keys they
// may mint for themselves.
type meIdentity struct {
	UserID string
	TeamID string
	Role   string
	Scopes []string
}

// meKeyContext resolves the caller's identity for self-service key management, preferring
// a JWT access token, then a proxy API key. Returns false when no user can be identified.
func (s *Server) meKeyContext(r *http.Request) (meIdentity, bool) {
	if claims, ok := s.currentAccessClaims(r); ok && strings.TrimSpace(claims.Subject) != "" {
		return meIdentity{UserID: claims.Subject, TeamID: claims.TeamID, Role: claims.Role, Scopes: claims.Scopes}, true
	}
	if _, authCtx, ok := s.authenticateProxyContext(r); ok && authCtx != nil && strings.TrimSpace(authCtx.UserID) != "" {
		return meIdentity{UserID: authCtx.UserID, TeamID: authCtx.TeamID, Role: authCtx.Role, Scopes: authCtx.Scopes}, true
	}
	return meIdentity{}, false
}

// scopesWithin reports whether every requested scope is allowed (subset), so a user cannot
// grant a self-issued key more than they themselves hold.
func scopesWithin(requested, allowed []string) bool {
	for _, sc := range requested {
		if !hasScope(allowed, sc) {
			return false
		}
	}
	return true
}

// handleMyKeys is self-service API key management for the calling user (opt-in via
// SELF_SERVICE_KEYS_ENABLED). GET lists the caller's own keys; POST issues a new key
// owned by the caller, capped to the caller's scopes.
// GET/POST /me/keys
func (s *Server) handleMyKeys(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.SelfServiceKeys {
		writeOpenAIError(w, http.StatusNotFound, "self-service key management is disabled", "invalid_request_error", "not_found")
		return
	}
	me, ok := s.meKeyContext(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		all, err := s.db.ListAPIKeys(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "keys_failed")
			return
		}
		mine := []store.APIKeyPublic{}
		for _, k := range all {
			if k.UserID == me.UserID {
				mine = append(mine, k)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"api_keys": mine})
	case http.MethodPost:
		var payload struct {
			Name      string   `json:"name"`
			Scopes    []string `json:"scopes"`
			ExpiresAt string   `json:"expires_at"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		secret, rec, errResp := s.issueSelfServiceKey(r, me, strings.TrimSpace(payload.Name), payload.Scopes, payload.ExpiresAt)
		if errResp != nil {
			writeOpenAIError(w, errResp.status, errResp.msg, errResp.typ, errResp.code)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"api_key": map[string]any{"id": rec.ID, "name": rec.Name, "user_id": rec.UserID, "team": rec.Team, "role": rec.Role, "scopes": rec.Scopes, "status": rec.Status},
			"secret":  secret,
		})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleMyKeyByID handles rotate/revoke of one of the caller's own keys.
// POST /me/keys/{id}/rotate ; DELETE /me/keys/{id}
func (s *Server) handleMyKeyByID(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.SelfServiceKeys {
		writeOpenAIError(w, http.StatusNotFound, "self-service key management is disabled", "invalid_request_error", "not_found")
		return
	}
	me, ok := s.meKeyContext(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/me/keys/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "key id required", "invalid_request_error", "invalid_id")
		return
	}
	existing, found, err := s.db.GetAPIKey(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_lookup_failed")
		return
	}
	// Ownership: only the caller's own keys; respond 404 (not 403) so others' ids aren't probeable.
	if !found || existing.UserID != me.UserID {
		writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
		return
	}

	switch {
	case action == "rotate" && r.Method == http.MethodPost:
		// Issue a replacement carrying the same name/scopes, then revoke the old key.
		secret, rec, errResp := s.issueSelfServiceKey(r, me, existing.Name, existing.Scopes, "")
		if errResp != nil {
			writeOpenAIError(w, errResp.status, errResp.msg, errResp.typ, errResp.code)
			return
		}
		if err := s.db.RevokeAPIKey(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_rotate_failed")
			return
		}
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_rotated", APIKeyID: id, ActorUserID: me.UserID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "self-service → " + rec.ID, CreatedAt: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]any{
			"rotated_from": id,
			"api_key":      map[string]any{"id": rec.ID, "name": rec.Name, "user_id": rec.UserID, "role": rec.Role, "scopes": rec.Scopes, "status": rec.Status},
			"secret":       secret,
		})
	case action == "" && r.Method == http.MethodDelete:
		if err := s.db.RevokeAPIKey(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_revoke_failed")
			return
		}
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_revoked", APIKeyID: id, ActorUserID: me.UserID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "self-service", CreatedAt: time.Now().UTC()})
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "revoked"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleKeyHealth returns active keys needing attention (expiring/expired/never-used/
// idle) across all users, for admins. Read-only.
// GET /admin/keys/health?stale_days=30&expiring_days=7
func (s *Server) handleKeyHealth(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	staleDays := intQuery(r, "stale_days", 30)
	expiringDays := intQuery(r, "expiring_days", 7)
	alerts, err := s.db.KeyHealthAlerts(r.Context(), time.Now().UTC(), staleDays, expiringDays, "")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_health_failed")
		return
	}
	high := 0
	for _, a := range alerts {
		if a.Severity == "high" {
			high++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stale_days": staleDays, "expiring_days": expiringDays,
		"high_severity": high, "alerts": alerts,
	})
}

type meKeyError struct {
	status int
	msg    string
	typ    string
	code   string
}

// issueSelfServiceKey creates a new active key owned by the caller, with the caller's role,
// scopes capped to the caller's own scopes (no escalation). Returns the plaintext secret.
func (s *Server) issueSelfServiceKey(r *http.Request, me meIdentity, name string, requestedScopes []string, expiresAt string) (string, store.APIKeyRecord, *meKeyError) {
	if name == "" {
		return "", store.APIKeyRecord{}, &meKeyError{http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name"}
	}
	scopes := me.Scopes
	if len(requestedScopes) > 0 {
		normalized, ok := normalizeScopes(requestedScopes)
		if !ok {
			return "", store.APIKeyRecord{}, &meKeyError{http.StatusBadRequest, "invalid scope", "invalid_request_error", "invalid_scope"}
		}
		if !scopesWithin(normalized, me.Scopes) {
			s.auditAuthEvent(r.Context(), "scope_denied", me.UserID, "", me.TeamID, "self-service key scopes exceed caller")
			return "", store.APIKeyRecord{}, &meKeyError{http.StatusForbidden, "cannot grant scopes beyond your own", "permission_error", "scope_denied"}
		}
		scopes = normalized
	}
	plainKey, err := generateAuthAPIKey(s.cfg.Auth.APIKeyPrefix)
	if err != nil {
		return "", store.APIKeyRecord{}, &meKeyError{http.StatusInternalServerError, err.Error(), "server_error", "key_generation_failed"}
	}
	rec := store.APIKeyRecord{
		ID:        "key_" + hashProxyKey(plainKey)[:16],
		Name:      name,
		KeyHash:   hashProxyKey(plainKey),
		Team:      me.TeamID,
		UserID:    me.UserID,
		Role:      me.Role,
		Status:    "active",
		Scopes:    scopes,
		ExpiresAt: parseAPITime(expiresAt),
	}
	if err := s.db.UpsertAPIKey(r.Context(), rec); err != nil {
		return "", store.APIKeyRecord{}, &meKeyError{http.StatusInternalServerError, err.Error(), "server_error", "api_key_create_failed"}
	}
	_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_created", APIKeyID: rec.ID, ActorUserID: me.UserID, TeamID: me.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "self-service: " + name, CreatedAt: time.Now().UTC()})
	return plainKey, rec, nil
}
