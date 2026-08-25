package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handleSSOStatus is a public endpoint telling the login screen whether SSO is available.
// GET /auth/sso/status
func (s *Server) handleSSOStatus(w http.ResponseWriter, r *http.Request) {
	kc := s.keycloakConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"keycloak_enabled":  kc.Enabled,
		"allow_local_login": !kc.Enabled || kc.AllowLocalLogin,
		"login_url":         "/auth/keycloak/login",
	})
}

// handleKeycloakLogin starts the Authorization Code + PKCE flow and redirects to Keycloak.
// GET /auth/keycloak/login
func (s *Server) handleKeycloakLogin(w http.ResponseWriter, r *http.Request) {
	kc := s.keycloakConfig()
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
	s.saveOIDCFlow(r.Context(), state, nonce, verifier)

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
	kc := s.keycloakConfig()
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
	fs, ok := s.takeOIDCFlow(r.Context(), state)
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
	pair, sessionID, err := s.issueTokenPairWithSession(r.Context(), user, team, clientIP(r), r.UserAgent())
	if err != nil {
		fail("session issue failed")
		return
	}
	// Link the Keycloak session id (sid claim) so front-/back-channel logout can target it.
	if sid := strClaim(claims, "sid"); sid != "" {
		_ = s.db.LinkAuthSessionKeycloakSID(r.Context(), sessionID, sid)
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
	kc := s.keycloakConfig()
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
	kc := s.keycloakConfig()
	sub := strClaim(claims, "sub")
	email := strClaim(claims, "email")
	name := firstNonEmpty(strClaim(claims, "name"), strClaim(claims, "preferred_username"), email)
	username := strClaim(claims, "preferred_username")
	if sub == "" {
		return store.AuthUser{}, "", &keycloakError{"id_token missing sub"}
	}
	role, roleExplicit := resolveKeycloakRoleExplicit(s.effectiveKeycloakRoleMap(), s.keycloakRolesFromClaims(claims), kc.DefaultRole)
	if role == "" {
		return store.AuthUser{}, "", &keycloakError{"no role mapping matched and no default role — login blocked"}
	}
	team := keycloakTeamFromGroups(claimStrings(claims, kc.GroupClaim))

	// effectiveTeam falls back to the user's current primary team when the IdP groups claim carries
	// no team — otherwise an SSO login would drop a user out of their existing team ("팀 없음").
	effectiveTeam := func(userID string) string {
		if team != "" {
			return team
		}
		if existing, err := s.db.PrimaryTeamForUser(ctx, userID); err == nil {
			return existing
		}
		return ""
	}

	// 1) Existing linked identity → load + sync status. Only an explicit claim→role mapping
	// changes the role; a default-fallback role must NOT overwrite the user's existing role
	// (otherwise e.g. a super_admin whose IdP carries no mapped role gets demoted to the default).
	if id, found, _ := s.db.AuthIdentityBySubject(ctx, "keycloak", kc.IssuerURL, sub); found {
		if user, ok, _ := s.db.AuthUserByID(ctx, id.UserID); ok {
			newRole := user.Role
			if roleExplicit {
				newRole = role
			}
			_ = s.db.UpdateAuthUserRoleStatus(ctx, user.ID, newRole, "active")
			user.Role, user.Status = newRole, "active"
			eff := effectiveTeam(user.ID)
			s.finishKeycloakLink(ctx, user.ID, sub, email, username, team)
			return user, eff, nil
		}
	}
	// 2) Existing local user with same email → merge by linking.
	if email != "" {
		if user, found, _ := s.db.AuthUserByEmail(ctx, email); found {
			eff := effectiveTeam(user.ID)
			s.finishKeycloakLink(ctx, user.ID, sub, email, username, team)
			return user, eff, nil
		}
	}
	// 3) New user.
	user := store.AuthUser{
		ID:           "usr_" + audit.HashText("keycloak|" + kc.IssuerURL + "|" + sub)[:16],
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
		ID: newID("authid"), UserID: userID, Provider: "keycloak", Issuer: s.keycloakConfig().IssuerURL,
		Subject: sub, Email: email, PreferredUsername: username,
	})
	if team != "" {
		// Group → team auto-create: ensure the team row exists before linking membership.
		_ = s.db.UpsertAuthTeam(ctx, store.AuthTeam{ID: team, Name: team})
		_ = s.db.SetUserTeam(ctx, userID, team, "")
	}
}

// backchannelLogoutEvent reports whether a logout_token's `events` claim contains the
// OIDC back-channel-logout event (per the spec it must).
func backchannelLogoutEvent(claims map[string]any) bool {
	ev, ok := claims["events"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = ev["http://schemas.openid.net/event/backchannel-logout"]
	return ok
}

// handleKeycloakBackchannelLogout terminates the internal sessions for a user when Keycloak
// ends their SSO session and POSTs a (RS256-signed) logout_token. Verified against JWKS;
// the subject is mapped to an internal user and all their sessions are revoked.
// POST /auth/keycloak/backchannel-logout  (form: logout_token=<jwt>)
func (s *Server) handleKeycloakBackchannelLogout(w http.ResponseWriter, r *http.Request) {
	if !s.keycloakConfig().Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	logoutToken := strings.TrimSpace(r.FormValue("logout_token"))
	if logoutToken == "" {
		// Some senders use JSON.
		var body struct {
			LogoutToken string `json:"logout_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		logoutToken = strings.TrimSpace(body.LogoutToken)
	}
	if logoutToken == "" {
		writeOpenAIError(w, http.StatusBadRequest, "missing logout_token", "invalid_request_error", "missing_token")
		return
	}
	disc, err := keycloakDiscover(r.Context(), s.keycloakConfig().IssuerURL)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "discovery failed", "server_error", "discovery_failed")
		return
	}
	claims, err := s.keycloakVerifyJWT(r.Context(), disc, logoutToken)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "logout_token verification failed: "+err.Error(), "invalid_request_error", "invalid_token")
		return
	}
	// audience + back-channel event.
	if !audienceMatches(claims["aud"], s.keycloakConfig().ClientID) {
		if azp, _ := claims["azp"].(string); azp != s.keycloakConfig().ClientID {
			writeOpenAIError(w, http.StatusBadRequest, "logout_token audience mismatch", "invalid_request_error", "invalid_token")
			return
		}
	}
	if !backchannelLogoutEvent(claims) {
		writeOpenAIError(w, http.StatusBadRequest, "logout_token missing back-channel-logout event", "invalid_request_error", "invalid_token")
		return
	}
	// Per the OIDC back-channel spec the logout_token carries sub and/or sid.
	sub := strClaim(claims, "sub")
	sid := strClaim(claims, "sid")
	if sub == "" && sid == "" {
		writeOpenAIError(w, http.StatusBadRequest, "logout_token missing sub and sid", "invalid_request_error", "invalid_token")
		return
	}
	if sid != "" {
		// Targeted: revoke only the session(s) linked to this Keycloak sid.
		if users, _ := s.db.RevokeAuthSessionsByKeycloakSID(r.Context(), sid); len(users) > 0 {
			s.auditAuthEvent(r.Context(), "sso_backchannel_logout", users[0], "", "", "keycloak sid="+sid+" sub="+sub)
		}
	} else if id, found, _ := s.db.AuthIdentityBySubject(r.Context(), "keycloak", s.keycloakConfig().IssuerURL, sub); found {
		// No sid → log out every session for the subject.
		_ = s.db.RevokeAuthSessionsForUser(r.Context(), id.UserID)
		s.auditAuthEvent(r.Context(), "sso_backchannel_logout", id.UserID, "", "", "keycloak sub="+sub)
	}
	w.WriteHeader(http.StatusOK)
}

// handleKeycloakFrontchannelLogout handles OIDC front-channel logout: the OP renders this URL
// in a hidden iframe when the user logs out elsewhere. We validate the issuer and revoke the
// internal session(s) linked to the supplied sid. No body/token is sent, so sid is the only
// reliable handle. GET /auth/keycloak/frontchannel-logout?iss=<issuer>&sid=<session_id>
func (s *Server) handleKeycloakFrontchannelLogout(w http.ResponseWriter, r *http.Request) {
	if !s.keycloakConfig().Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	// Front-channel logout responses must not be cached.
	w.Header().Set("Cache-Control", "no-store")
	iss := r.URL.Query().Get("iss")
	sid := strings.TrimSpace(r.URL.Query().Get("sid"))
	// When iss is provided it must match our configured issuer (spec recommends validating it).
	if iss != "" && iss != s.keycloakConfig().IssuerURL {
		writeOpenAIError(w, http.StatusBadRequest, "issuer mismatch", "invalid_request_error", "bad_issuer")
		return
	}
	if sid != "" {
		if users, _ := s.db.RevokeAuthSessionsByKeycloakSID(r.Context(), sid); len(users) > 0 {
			s.auditAuthEvent(r.Context(), "sso_frontchannel_logout", users[0], "", "", "keycloak sid="+sid)
		}
	}
	// Return a minimal page (the OP loads this in an iframe).
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("<!doctype html><title>logout</title>"))
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
	if disc, err := keycloakDiscover(r.Context(), s.keycloakConfig().IssuerURL); err == nil && disc.EndSessionEndpoint != "" {
		q := url.Values{}
		q.Set("client_id", s.keycloakConfig().ClientID)
		if p.IDTokenHint != "" {
			q.Set("id_token_hint", p.IDTokenHint)
		}
		if s.keycloakConfig().RedirectURI != "" {
			// post-logout lands back on the admin login.
			base := s.keycloakConfig().RedirectURI
			if i := strings.Index(base, "/auth/keycloak/callback"); i >= 0 {
				base = base[:i] + "/admin"
			}
			q.Set("post_logout_redirect_uri", base)
		}
		endSession = disc.EndSessionEndpoint + "?" + q.Encode()
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "logged_out", "end_session_url": endSession})
}

// handleKeycloakConfig returns the (non-secret) Keycloak config for the admin SSO screen.
// GET /admin/sso/keycloak/config
func (s *Server) handleKeycloakConfig(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	kc := s.keycloakConfig()
	rec, dbBacked := s.storedKeycloakConfig(r.Context())
	source := "env"
	updatedAt, updatedBy := "", ""
	if dbBacked {
		source = "db"
		updatedAt, updatedBy = rec.UpdatedAt, rec.UpdatedBy
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":           kc.Enabled,
		"issuer_url":        kc.IssuerURL,
		"client_id":         kc.ClientID,
		"client_secret_set": kc.ClientSecret != "",
		"redirect_uri":      kc.RedirectURI,
		"scopes":            kc.Scopes,
		"default_role":      kc.DefaultRole,
		"role_claim":        kc.RoleClaim,
		"group_claim":       kc.GroupClaim,
		"allow_local_login": kc.AllowLocalLogin,
		"role_map":          s.effectiveKeycloakRoleMap(),
		"role_map_default":  keycloakRoleMap,
		"role_map_custom":   len(kc.RoleMap) > 0,
		"source":            source, // "db" = admin override (secret AES-GCM at rest), "env" = SSO_KEYCLOAK_*
		"db_backed":         dbBacked,
		"updated_at":        updatedAt,
		"updated_by":        updatedBy,
		"note":              "source=db이면 관리자 화면 설정이 우선 적용되며 client secret은 AES-GCM으로 암호화 저장됩니다. db 설정이 없으면 환경변수(SSO_KEYCLOAK_*)가 사용됩니다.",
	})
}

// handleKeycloakConfigSave persists a DB-backed Keycloak provider override. The client secret
// is encrypted at rest (AES-GCM) and never echoed back. An omitted client_secret keeps the
// stored one (so admins can edit other fields without re-entering it); an explicit empty string
// clears it. PUT /admin/sso/keycloak/config
func (s *Server) handleKeycloakConfigSave(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Enabled         bool              `json:"enabled"`
		IssuerURL       string            `json:"issuer_url"`
		ClientID        string            `json:"client_id"`
		ClientSecret    *string           `json:"client_secret"` // nil/omitted = keep existing; "" = clear
		RedirectURI     string            `json:"redirect_uri"`
		Scopes          []string          `json:"scopes"`
		DefaultRole     string            `json:"default_role"`
		RoleClaim       string            `json:"role_claim"`
		GroupClaim      string            `json:"group_claim"`
		AllowLocalLogin bool              `json:"allow_local_login"`
		RoleMap         map[string]string `json:"role_map"` // nil/omitted = keep existing; {} = reset to defaults
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
		return
	}
	p.IssuerURL = strings.TrimSpace(p.IssuerURL)
	p.ClientID = strings.TrimSpace(p.ClientID)
	p.RedirectURI = strings.TrimSpace(p.RedirectURI)
	// Validation: when enabling, issuer must be an absolute URL and client id present.
	if p.Enabled {
		if !strings.HasPrefix(p.IssuerURL, "https://") && !strings.HasPrefix(p.IssuerURL, "http://") {
			writeOpenAIError(w, http.StatusBadRequest, "issuer_url must be an absolute http(s) URL", "invalid_request_error", "bad_issuer")
			return
		}
		if p.ClientID == "" {
			writeOpenAIError(w, http.StatusBadRequest, "client_id is required when enabling SSO", "invalid_request_error", "bad_client_id")
			return
		}
		if p.RedirectURI != "" && !strings.HasPrefix(p.RedirectURI, "http://") && !strings.HasPrefix(p.RedirectURI, "https://") {
			writeOpenAIError(w, http.StatusBadRequest, "redirect_uri must be an absolute http(s) URL", "invalid_request_error", "bad_redirect")
			return
		}
	}

	prev, _ := s.storedKeycloakConfig(r.Context())
	rec := store.SSOProviderConfig{
		Provider:        "keycloak",
		Enabled:         p.Enabled,
		IssuerURL:       p.IssuerURL,
		ClientID:        p.ClientID,
		RedirectURI:     p.RedirectURI,
		Scopes:          p.Scopes,
		DefaultRole:     strings.TrimSpace(p.DefaultRole),
		RoleClaim:       strings.TrimSpace(p.RoleClaim),
		GroupClaim:      strings.TrimSpace(p.GroupClaim),
		AllowLocalLogin: p.AllowLocalLogin,
		ClientSecretEnc: prev.ClientSecretEnc, // default: keep the existing encrypted secret
		RoleMap:         prev.RoleMap,         // default: keep existing custom map
	}
	// role_map: nil/omitted → keep existing; non-nil (incl. {}) → replace (empty resets to defaults).
	if p.RoleMap != nil {
		cleaned := map[string]string{}
		for k, v := range p.RoleMap {
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if k == "" || v == "" {
				continue
			}
			if !s.effectiveValidRole(r.Context(), v) {
				writeOpenAIError(w, http.StatusBadRequest, "role_map target is not a valid internal role: "+v, "invalid_request_error", "bad_role")
				return
			}
			cleaned[k] = v
		}
		rec.RoleMap = cleaned
	}
	if p.ClientSecret != nil {
		sec := strings.TrimSpace(*p.ClientSecret)
		if sec == "" {
			rec.ClientSecretEnc = "" // explicit clear
		} else {
			enc, err := s.secrets.Load().Encrypt(sec)
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, "failed to encrypt client secret", "server_error", "encrypt_failed")
				return
			}
			rec.ClientSecretEnc = enc
		}
	}
	if claims, ok := s.currentAccessClaims(r); ok {
		rec.UpdatedBy = claims.Email
	}
	if err := s.db.SaveSSOProviderConfig(r.Context(), rec); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to save SSO config: "+err.Error(), "server_error", "save_failed")
		return
	}
	s.reloadKeycloakConfig(r.Context())
	// Never log the secret/code; record only the actor + enabled state.
	s.auditAuthEvent(r.Context(), "sso_config_updated", rec.UpdatedBy, "", "", "keycloak enabled="+boolStr(rec.Enabled)+" issuer="+rec.IssuerURL)
	w.WriteHeader(http.StatusNoContent)
}

// handleKeycloakTest diagnoses the Keycloak connection: discovery reachability, endpoints,
// and JWKS key count. Admin-only. POST /admin/sso/keycloak/test
func (s *Server) handleKeycloakTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if !s.keycloakConfig().Enabled {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "SSO_KEYCLOAK_ENABLED=false"})
		return
	}
	if strings.TrimSpace(s.keycloakConfig().IssuerURL) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "reason": "issuer URL is empty"})
		return
	}
	disc, err := keycloakDiscover(r.Context(), s.keycloakConfig().IssuerURL)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "stage": "discovery", "reason": err.Error()})
		return
	}
	var set jwkSet
	keyCount := 0
	if e := oidcGetJSON(r.Context(), disc.JWKSURI, &set); e == nil {
		for _, k := range set.Keys {
			if k.Kty == "RSA" {
				keyCount++
			}
		}
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "stage": "jwks", "reason": e.Error(), "discovery": disc})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "issuer": disc.Issuer,
		"authorization_endpoint": disc.AuthorizationEndpoint,
		"token_endpoint":         disc.TokenEndpoint,
		"jwks_uri":               disc.JWKSURI,
		"end_session_endpoint":   disc.EndSessionEndpoint,
		"rsa_signing_keys":       keyCount,
	})
}

func strClaim(claims map[string]any, key string) string {
	if v, ok := claims[key].(string); ok {
		return v
	}
	return ""
}
