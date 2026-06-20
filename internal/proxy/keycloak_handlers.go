package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handleSSOStatus is a public endpoint telling the login screen whether SSO is available.
// GET /auth/sso/status
func (s *Server) handleSSOStatus(w http.ResponseWriter, r *http.Request) {
	kc := s.cfg.Keycloak
	writeJSON(w, http.StatusOK, map[string]any{
		"keycloak_enabled":  kc.Enabled,
		"allow_local_login": !kc.Enabled || kc.AllowLocalLogin,
		"login_url":         "/auth/keycloak/login",
	})
}

// handleKeycloakLogin starts the Authorization Code + PKCE flow and redirects to Keycloak.
// GET /auth/keycloak/login
func (s *Server) handleKeycloakLogin(w http.ResponseWriter, r *http.Request) {
	kc := s.cfg.Keycloak
	if !kc.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	disc, err := keycloakDiscover(r.Context(), kc.IssuerURL)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "OIDC discovery failed: "+err.Error(), "server_error", "discovery_failed")
		return
	}
	state := randomURLSafe(24)
	nonce := randomURLSafe(24)
	verifier := randomURLSafe(48)
	storeFlowState(state, oidcFlowState{nonce: nonce, verifier: verifier, created: time.Now()})

	q := url.Values{}
	q.Set("client_id", kc.ClientID)
	q.Set("response_type", "code")
	q.Set("scope", strings.Join(kc.Scopes, " "))
	q.Set("redirect_uri", kc.RedirectURI)
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge", pkceChallenge(verifier))
	q.Set("code_challenge_method", "S256")
	http.Redirect(w, r, disc.AuthorizationEndpoint+"?"+q.Encode(), http.StatusFound)
}

// handleKeycloakCallback handles the Authorization Code redirect: validates state, exchanges
// the code (with PKCE verifier), verifies the ID token, maps the user, issues an internal
// session, and redirects back to the admin UI with the tokens in the URL fragment.
// GET /auth/keycloak/callback
func (s *Server) handleKeycloakCallback(w http.ResponseWriter, r *http.Request) {
	kc := s.cfg.Keycloak
	if !kc.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	fail := func(reason string) {
		s.auditAuthEvent(r.Context(), "sso_login_failed", "", "", "", "keycloak: "+reason)
		http.Redirect(w, r, "/admin#kc_error="+url.QueryEscape(reason), http.StatusFound)
	}
	if e := r.URL.Query().Get("error"); e != "" {
		fail(e + ": " + r.URL.Query().Get("error_description"))
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		fail("missing code or state")
		return
	}
	fs, ok := takeFlowState(state)
	if !ok {
		fail("invalid or expired state (CSRF check failed)")
		return
	}
	disc, err := keycloakDiscover(r.Context(), kc.IssuerURL)
	if err != nil {
		fail("discovery failed")
		return
	}
	tok, err := s.keycloakExchangeCode(r.Context(), disc, code, fs.verifier)
	if err != nil {
		fail("token exchange failed: " + err.Error())
		return
	}
	claims, err := s.verifyKeycloakIDToken(r.Context(), disc, tok.IDToken, fs.nonce)
	if err != nil {
		fail("id_token verification failed: " + err.Error())
		return
	}
	user, team, err := s.provisionKeycloakUser(r.Context(), claims)
	if err != nil {
		fail(err.Error())
		return
	}
	pair, err := s.issueTokenPair(r.Context(), user, team, clientIP(r), r.UserAgent())
	if err != nil {
		fail("session issue failed")
		return
	}
	s.auditAuthEvent(r.Context(), "sso_login", user.ID, "", team, "keycloak sub="+strClaim(claims, "sub")+" role="+user.Role)
	access, _ := pair["access_token"].(string)
	refresh, _ := pair["refresh_token"].(string)
	frag := url.Values{}
	frag.Set("kc_access", access)
	frag.Set("kc_refresh", refresh)
	http.Redirect(w, r, "/admin#"+frag.Encode(), http.StatusFound)
}

type keycloakTokenResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

// keycloakExchangeCode swaps an authorization code (+ PKCE verifier) for tokens.
func (s *Server) keycloakExchangeCode(ctx context.Context, disc oidcDiscovery, code, verifier string) (keycloakTokenResponse, error) {
	kc := s.cfg.Keycloak
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", kc.RedirectURI)
	form.Set("client_id", kc.ClientID)
	if kc.ClientSecret != "" {
		form.Set("client_secret", kc.ClientSecret)
	}
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, disc.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return keycloakTokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := oidcHTTP.Do(req)
	if err != nil {
		return keycloakTokenResponse{}, err
	}
	defer resp.Body.Close()
	var tr keycloakTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return keycloakTokenResponse{}, err
	}
	if tr.Error != "" {
		return keycloakTokenResponse{}, &keycloakError{tr.Error + ": " + tr.ErrorDesc}
	}
	if tr.IDToken == "" {
		return keycloakTokenResponse{}, &keycloakError{"no id_token in token response"}
	}
	return tr, nil
}

type keycloakError struct{ msg string }

func (e *keycloakError) Error() string { return e.msg }

// provisionKeycloakUser resolves (or creates) the internal user for a verified ID token,
// syncing role and team from claims. Returns the user and resolved team id.
func (s *Server) provisionKeycloakUser(ctx context.Context, claims map[string]any) (store.AuthUser, string, error) {
	kc := s.cfg.Keycloak
	sub := strClaim(claims, "sub")
	email := strClaim(claims, "email")
	name := firstNonEmpty(strClaim(claims, "name"), strClaim(claims, "preferred_username"), email)
	username := strClaim(claims, "preferred_username")
	if sub == "" {
		return store.AuthUser{}, "", &keycloakError{"id_token missing sub"}
	}
	role := resolveKeycloakRole(s.keycloakRolesFromClaims(claims), kc.DefaultRole)
	if role == "" {
		return store.AuthUser{}, "", &keycloakError{"no role mapping matched and no default role — login blocked"}
	}
	team := keycloakTeamFromGroups(claimStrings(claims, kc.GroupClaim))

	// 1) Existing linked identity → load + sync role/status.
	if id, found, _ := s.db.AuthIdentityBySubject(ctx, "keycloak", kc.IssuerURL, sub); found {
		if user, ok, _ := s.db.AuthUserByID(ctx, id.UserID); ok {
			_ = s.db.UpdateAuthUserRoleStatus(ctx, user.ID, role, "active")
			user.Role, user.Status = role, "active"
			s.finishKeycloakLink(ctx, user.ID, sub, email, username, team)
			return user, team, nil
		}
	}
	// 2) Existing local user with same email → merge by linking.
	if email != "" {
		if user, found, _ := s.db.AuthUserByEmail(ctx, email); found {
			s.finishKeycloakLink(ctx, user.ID, sub, email, username, team)
			return user, team, nil
		}
	}
	// 3) New user.
	user := store.AuthUser{
		ID:           "usr_" + audit.HashText("keycloak|"+kc.IssuerURL+"|"+sub)[:16],
		Email:        firstNonEmpty(email, sub+"@sso.local"),
		PasswordHash: "", // SSO-only account (no local password)
		Name:         name,
		Role:         role,
		Status:       "active",
	}
	if err := s.db.CreateAuthUser(ctx, user); err != nil {
		return store.AuthUser{}, "", err
	}
	s.finishKeycloakLink(ctx, user.ID, sub, email, username, team)
	return user, team, nil
}

// finishKeycloakLink upserts the identity row and (best-effort) the team membership.
func (s *Server) finishKeycloakLink(ctx context.Context, userID, sub, email, username, team string) {
	_ = s.db.UpsertAuthIdentity(ctx, store.AuthIdentity{
		ID: newID("authid"), UserID: userID, Provider: "keycloak", Issuer: s.cfg.Keycloak.IssuerURL,
		Subject: sub, Email: email, PreferredUsername: username,
	})
	if team != "" {
		_ = s.db.SetUserTeam(ctx, userID, team, "")
	}
}

// handleKeycloakLogout clears the internal session and returns the Keycloak end-session URL
// so the SPA can complete RP-initiated logout. POST /auth/keycloak/logout {refresh_token}
func (s *Server) handleKeycloakLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		RefreshToken string `json:"refresh_token"`
		IDTokenHint  string `json:"id_token_hint"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	// Local logout: revoke the internal refresh token / session.
	if strings.TrimSpace(p.RefreshToken) != "" {
		if rec, found, err := s.db.RefreshTokenByHash(r.Context(), hashProxyKey(p.RefreshToken)); err == nil && found {
			_ = s.db.RevokeRefreshToken(r.Context(), rec.ID)
		}
	}
	if claims, ok := s.currentAccessClaims(r); ok {
		s.auditAuthEvent(r.Context(), "sso_logout", claims.Subject, "", claims.TeamID, "keycloak")
	}
	endSession := ""
	if disc, err := keycloakDiscover(r.Context(), s.cfg.Keycloak.IssuerURL); err == nil && disc.EndSessionEndpoint != "" {
		q := url.Values{}
		q.Set("client_id", s.cfg.Keycloak.ClientID)
		if p.IDTokenHint != "" {
			q.Set("id_token_hint", p.IDTokenHint)
		}
		if s.cfg.Keycloak.RedirectURI != "" {
			// post-logout lands back on the admin login.
			base := s.cfg.Keycloak.RedirectURI
			if i := strings.Index(base, "/auth/keycloak/callback"); i >= 0 {
				base = base[:i] + "/admin"
			}
			q.Set("post_logout_redirect_uri", base)
		}
		endSession = disc.EndSessionEndpoint + "?" + q.Encode()
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "logged_out", "end_session_url": endSession})
}

func strClaim(claims map[string]any, key string) string {
	if v, ok := claims[key].(string); ok {
		return v
	}
	return ""
}

