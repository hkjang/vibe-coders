package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"vibe-coders/internal/store"
)

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if kc := s.keycloakConfig(); kc.Enabled && !kc.AllowLocalLogin {
		writeOpenAIError(w, http.StatusForbidden, "local login is disabled; use Keycloak SSO", "invalid_request_error", "local_login_disabled")
		return
	}
	var p struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	user, found, err := s.db.AuthUserByEmail(r.Context(), email)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "login_failed")
		return
	}
	if !found || user.Status != "active" || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(p.Password)) != nil {
		_ = s.db.InsertLoginAttempt(r.Context(), email, false, clientIP(r), r.UserAgent(), "invalid_credentials")
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "login_failed", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: email, CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusUnauthorized, "invalid email or password", "invalid_request_error", "invalid_credentials")
		return
	}
	teamID, _ := s.db.PrimaryTeamForUser(r.Context(), user.ID)
	tokens, err := s.issueTokenPair(r.Context(), user, teamID, clientIP(r), r.UserAgent())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "login_failed")
		return
	}
	_ = s.db.InsertLoginAttempt(r.Context(), email, true, clientIP(r), r.UserAgent(), "")
	_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "login_success", ActorUserID: user.ID, TeamID: teamID, IP: clientIP(r), UserAgent: r.UserAgent(), CreatedAt: time.Now().UTC()})
	writeJSON(w, http.StatusOK, tokens)
}

func (s *Server) handleAuthRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	out, err := s.rotateRefreshToken(r.Context(), strings.TrimSpace(p.RefreshToken), clientIP(r), r.UserAgent())
	if err != nil {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "login_failed", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "refresh: " + err.Error(), CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusUnauthorized, "invalid refresh token", "invalid_request_error", "invalid_refresh_token")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if claims, ok := s.verifyAccessToken(r.Context(), bearerToken(r.Header.Get("Authorization"))); ok {
		_ = s.db.RevokeAuthSession(r.Context(), claims.SessionID)
	}
	var p struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	if p.RefreshToken != "" {
		if rec, found, _ := s.db.RefreshTokenByHash(r.Context(), hashProxyKey(p.RefreshToken)); found {
			_ = s.db.RevokeRefreshToken(r.Context(), rec.ID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.cfg.Auth.Enabled {
		writeJSON(w, http.StatusOK, map[string]any{
			"auth_enabled":        false,
			"credential_prefixes": uiCredentialPrefixes(s.cfg.Auth),
			"version":             AppVersion,
		})
		return
	}
	claims, ok := s.verifyAccessToken(r.Context(), bearerToken(r.Header.Get("Authorization")))
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"auth_enabled":        true,
		"credential_prefixes": uiCredentialPrefixes(s.cfg.Auth),
		"version":             AppVersion,
		"expires_at":          claims.ExpiresAt, // unix seconds; the access token's expiry
		"menu_version":        menuVersion,
		"user": map[string]any{
			"id": claims.Subject, "email": claims.Email, "role": claims.Role,
			"roles":        []string{claims.Role},
			"team_id":      claims.TeamID,
			"cost_center":  "",
			"scopes":       claims.Scopes,
			"features":     s.featureFlags(),
			"default_home": resolveHome(claims.Role, claims.Scopes),
		},
	})
}

func (s *Server) handleAuthAuditEvents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	events, err := s.db.ListAuditEvents(r.Context(), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "auth_events_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}
