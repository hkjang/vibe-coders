package proxy

import (
	"net/http"
	"strings"
)

// handleMeSessions lists the caller's active login sessions, flagging the one in use.
// GET /me/sessions
func (s *Server) handleMeSessions(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	sessions, err := s.db.ListActiveAuthSessionsForUser(r.Context(), claims.Subject)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "sessions_failed")
		return
	}
	out := make([]map[string]any, 0, len(sessions))
	for _, si := range sessions {
		out = append(out, map[string]any{
			"id":         si.ID,
			"ip":         si.IP,
			"user_agent": si.UserAgent,
			"created_at": si.CreatedAt,
			"expires_at": si.ExpiresAt,
			"sso_linked": si.SSOLinked,
			"current":    si.ID == claims.SessionID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out, "current_session_id": claims.SessionID})
}

// handleMeSessionByID revokes one of the caller's own sessions. DELETE /me/sessions/{id}
func (s *Server) handleMeSessionByID(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	sessionID := strings.TrimPrefix(r.URL.Path, "/me/sessions/")
	if sessionID == "" || strings.Contains(sessionID, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "session id required", "invalid_request_error", "bad_request")
		return
	}
	revoked, err := s.db.RevokeAuthSessionOwned(r.Context(), sessionID, claims.Subject)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "revoke_failed")
		return
	}
	if !revoked {
		writeOpenAIError(w, http.StatusNotFound, "session not found or not yours", "invalid_request_error", "not_found")
		return
	}
	s.auditAuthEvent(r.Context(), "session_revoked", claims.Subject, "", claims.TeamID, "self-service revoke session="+sessionID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "revoked", "session_id": sessionID})
}

// handleMeSessionsRevokeOthers revokes every session except the current one ("log out
// everywhere else"). POST /me/sessions/revoke-others
func (s *Server) handleMeSessionsRevokeOthers(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	n, err := s.db.RevokeOtherAuthSessionsForUser(r.Context(), claims.Subject, claims.SessionID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "revoke_failed")
		return
	}
	s.auditAuthEvent(r.Context(), "session_revoked_others", claims.Subject, "", claims.TeamID, "self-service revoke others count="+itoaProxy(n))
	writeJSON(w, http.StatusOK, map[string]any{"status": "revoked", "revoked_count": n})
}
