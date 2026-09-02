package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const (
	oidcStateCookieName      = "vibe_oidc_state"
	ssoExchangeCookieName    = "vibe_sso_exchange"
	maxKeycloakJSONBodyBytes = int64(64 << 10)
)

func decodeKeycloakJSONBody(w http.ResponseWriter, r *http.Request, out any, allowEmpty bool) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxKeycloakJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(out); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	// Consume through EOF so the byte ceiling also covers trailing data, and reject a
	// second JSON value instead of silently accepting an ambiguous request.
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("multiple JSON values")
}

func writeKeycloakJSONBodyError(w http.ResponseWriter, err error, subject string) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeOpenAIError(w, http.StatusRequestEntityTooLarge, subject+" body is too large", "invalid_request_error", "body_too_large")
		return
	}
	writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
}

func (s *Server) authCookieSecure() bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.keycloakConfig().RedirectURI)), "https://")
}

func (s *Server) setTransientAuthCookie(w http.ResponseWriter, name, value, cookiePath string, maxAge int, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: cookiePath, MaxAge: maxAge,
		HttpOnly: true, Secure: s.authCookieSecure(), SameSite: sameSite,
	})
}

func safeAuthReturnTo(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "/admin", true
	}
	lower := strings.ToLower(raw)
	if strings.Contains(raw, "\\") || strings.ContainsAny(raw, "\r\n\x00") || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Fragment != "" || strings.HasPrefix(raw, "//") {
		return "", false
	}
	cleanPath := path.Clean(u.Path)
	if strings.HasSuffix(u.Path, "/") && cleanPath != "/" {
		cleanPath += "/"
	}
	if cleanPath != u.Path {
		return "", false
	}
	if u.Path == "/admin" && u.RawQuery == "" {
		return "/admin", true
	}
	if u.Path == "/app" {
		u.Path = "/app/"
	}
	if !strings.HasPrefix(u.Path, "/app/") {
		return "", false
	}
	return u.RequestURI(), true
}

// handleSSOStatus is a public endpoint telling the login screen whether SSO is available.
// GET /auth/sso/status
func (s *Server) handleSSOStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
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
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	kc := s.keycloakConfig()
	if !kc.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	returnTo, ok := safeAuthReturnTo(r.URL.Query().Get("return_to"))
	if !ok {
		writeOpenAIError(w, http.StatusBadRequest, "return_to must be an internal /app path", "invalid_request_error", "invalid_return_to")
		return
	}
	disc, err := keycloakDiscover(r.Context(), kc.IssuerURL)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "OIDC discovery failed: "+err.Error(), "server_error", "discovery_failed")
		return
	}
	state, err := randomURLSafe(24)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "secure login state generation failed", "server_error", "entropy_unavailable")
		return
	}
	nonce, err := randomURLSafe(24)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "secure login nonce generation failed", "server_error", "entropy_unavailable")
		return
	}
	verifier, err := randomURLSafe(48)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "secure PKCE generation failed", "server_error", "entropy_unavailable")
		return
	}
	s.saveOIDCFlow(r.Context(), state, nonce, verifier, returnTo)
	s.setTransientAuthCookie(w, oidcStateCookieName, state, "/auth/keycloak/callback", 600, http.SameSiteLaxMode)

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
// short-lived one-time exchange code, and redirects back to the UI. Access and refresh
// tokens are never placed in a redirect header, body, browser history, or URL fragment.
// GET /auth/keycloak/callback
func (s *Server) handleKeycloakCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	kc := s.keycloakConfig()
	if !kc.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "SSO is not enabled", "invalid_request_error", "sso_disabled")
		return
	}
	returnTo := "/admin"
	fail := func(reason string) {
		s.auditAuthEvent(r.Context(), "sso_login_failed", "", "", "", "keycloak: "+reason)
		http.Redirect(w, r, returnTo+"#kc_error="+url.QueryEscape(reason), http.StatusFound)
	}
	state := r.URL.Query().Get("state")
	stateCookie, cookieErr := r.Cookie(oidcStateCookieName)
	// Clear the short-lived browser binding on every callback outcome, including an
	// identity-provider error or malformed callback.
	s.setTransientAuthCookie(w, oidcStateCookieName, "", "/auth/keycloak/callback", -1, http.SameSiteLaxMode)
	if state == "" || cookieErr != nil || !secureTokenEqual(stateCookie.Value, state) {
		fail("login browser binding check failed")
		return
	}
	fs, ok := s.takeOIDCFlow(r.Context(), state)
	if !ok {
		fail("invalid or expired state (CSRF check failed)")
		return
	}
	if target, valid := safeAuthReturnTo(fs.returnTo); valid {
		returnTo = target
	}
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		// Never reflect the provider-controlled error_description into a redirect URL.
		// A small allowlist preserves actionable cancellation/availability outcomes.
		switch providerError {
		case "access_denied", "interaction_required", "login_required", "temporarily_unavailable":
			fail(providerError)
		default:
			fail("identity_provider_error")
		}
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("missing authorization code")
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
	exchangeCode, err := randomURLSafe(32)
	if err != nil {
		fail("secure session exchange generation failed")
		return
	}
	if err := s.db.SaveOIDCLoginExchange(r.Context(), store.OIDCLoginExchange{
		CodeHash: hashProxyKey(exchangeCode), UserID: user.ID, TeamID: team,
		KeycloakSID: strClaim(claims, "sid"), CreatedAt: time.Now().UTC(),
	}); err != nil {
		fail("session exchange initialization failed")
		return
	}
	s.setTransientAuthCookie(w, ssoExchangeCookieName, exchangeCode, "/auth/sso/exchange", 120, http.SameSiteStrictMode)
	s.auditAuthEvent(r.Context(), "sso_authorized", user.ID, "", team, "keycloak sub="+strClaim(claims, "sub")+" role="+user.Role)
	frag := url.Values{}
	frag.Set("kc_code", exchangeCode)
	http.Redirect(w, r, returnTo+"#"+frag.Encode(), http.StatusFound)
}

// handleSSOExchange consumes the one-time, browser-bound code returned by the OIDC callback
// and only then creates the internal session/token pair. POST /auth/sso/exchange {code}.
func (s *Server) handleSSOExchange(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	payload.Code = strings.TrimSpace(payload.Code)
	cookie, err := r.Cookie(ssoExchangeCookieName)
	s.setTransientAuthCookie(w, ssoExchangeCookieName, "", "/auth/sso/exchange", -1, http.SameSiteStrictMode)
	if err != nil || payload.Code == "" || len(payload.Code) > 128 || !secureTokenEqual(cookie.Value, payload.Code) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid or expired SSO exchange", "invalid_request_error", "invalid_sso_exchange")
		return
	}
	exchange, found, err := s.db.TakeOIDCLoginExchange(r.Context(), hashProxyKey(payload.Code))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to consume SSO exchange", "server_error", "sso_exchange_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid or expired SSO exchange", "invalid_request_error", "invalid_sso_exchange")
		return
	}
	user, found, err := s.db.AuthUserByID(r.Context(), exchange.UserID)
	if err != nil || !found || user.Status != "active" {
		writeOpenAIError(w, http.StatusUnauthorized, "SSO user is unavailable", "invalid_request_error", "sso_user_unavailable")
		return
	}
	pair, sessionID, err := s.issueTokenPairWithSession(r.Context(), user, exchange.TeamID, clientIP(r), r.UserAgent())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to issue SSO session", "server_error", "sso_session_failed")
		return
	}
	if exchange.KeycloakSID != "" {
		if err := s.db.LinkAuthSessionKeycloakSID(r.Context(), sessionID, exchange.KeycloakSID); err != nil {
			_ = s.db.RevokeAuthSession(r.Context(), sessionID)
			writeOpenAIError(w, http.StatusInternalServerError, "failed to bind SSO session", "server_error", "sso_session_link_failed")
			return
		}
	}
	s.auditAuthEvent(r.Context(), "sso_login", user.ID, "", exchange.TeamID, "keycloak one-time exchange")
	writeJSON(w, http.StatusOK, pair)
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxOIDCJSONBytes+1))
	if err != nil {
		return keycloakTokenResponse{}, err
	}
	if len(data) > maxOIDCJSONBytes {
		return keycloakTokenResponse{}, fmt.Errorf("OIDC token response exceeds %d bytes", maxOIDCJSONBytes)
	}
	if err := json.Unmarshal(data, &tr); err != nil {
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
	if email != "" {
		verified, ok := claims["email_verified"].(bool)
		if !ok || !verified {
			return store.AuthUser{}, "", &keycloakError{"id_token email is not verified"}
		}
	}
	role, _ := resolveKeycloakRoleExplicit(s.effectiveKeycloakRoleMap(), s.keycloakRolesFromClaims(claims), kc.DefaultRole)
	if role == "" {
		return store.AuthUser{}, "", &keycloakError{"no role mapping matched and no default role — login blocked"}
	}
	team := keycloakTeamFromGroups(claimStrings(claims, kc.GroupClaim))

	// 1) Existing linked identity → load + sync IdP-owned role and team. Falling back
	// to a prior local role/team when a claim disappears would preserve privileges after
	// an administrator revoked them in Keycloak.
	id, linked, err := s.db.AuthIdentityBySubject(ctx, "keycloak", kc.IssuerURL, sub)
	if err != nil {
		return store.AuthUser{}, "", err
	}
	if linked {
		user, found, err := s.db.AuthUserByID(ctx, id.UserID)
		if err != nil {
			return store.AuthUser{}, "", err
		}
		if !found {
			return store.AuthUser{}, "", &keycloakError{"linked SSO user no longer exists"}
		}
		if err := s.db.UpdateAuthUserRoleStatus(ctx, user.ID, role, "active"); err != nil {
			return store.AuthUser{}, "", err
		}
		user.Role, user.Status = role, "active"
		if err := s.finishKeycloakLink(ctx, user.ID, sub, email, username, team); err != nil {
			return store.AuthUser{}, "", err
		}
		return user, team, nil
	}
	// 2) Existing SSO-only, non-privileged user with the same verified email may be
	// linked. Local-password and privileged accounts require an explicit administrator
	// linking workflow; silently joining either by email would turn a weak/self-service
	// IdP realm into an account-takeover path.
	if email != "" {
		user, found, err := s.db.AuthUserByEmail(ctx, email)
		if err != nil {
			return store.AuthUser{}, "", err
		}
		if found {
			if user.PasswordHash != "" || user.Status != "active" || roleRank(user.Role) >= 3 || user.Role == "readonly_admin" || user.Role == "service_account" {
				return store.AuthUser{}, "", &keycloakError{"existing local, inactive, or privileged account requires explicit SSO linking"}
			}
			if err := s.db.UpdateAuthUserRoleStatus(ctx, user.ID, role, "active"); err != nil {
				return store.AuthUser{}, "", err
			}
			user.Role, user.Status = role, "active"
			if err := s.finishKeycloakLink(ctx, user.ID, sub, email, username, team); err != nil {
				return store.AuthUser{}, "", err
			}
			return user, team, nil
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
	if err := s.finishKeycloakLink(ctx, user.ID, sub, email, username, team); err != nil {
		return store.AuthUser{}, "", err
	}
	return user, team, nil
}

// finishKeycloakLink persists the identity and its IdP-owned team membership.
func (s *Server) finishKeycloakLink(ctx context.Context, userID, sub, email, username, team string) error {
	if err := s.db.UpsertAuthIdentity(ctx, store.AuthIdentity{
		ID: newID("authid"), UserID: userID, Provider: "keycloak", Issuer: s.keycloakConfig().IssuerURL,
		Subject: sub, Email: email, PreferredUsername: username,
	}); err != nil {
		return err
	}
	if team != "" {
		// Group → team auto-create: ensure the team row exists before linking membership.
		if err := s.db.UpsertAuthTeam(ctx, store.AuthTeam{ID: team, Name: team}); err != nil {
			return err
		}
	}
	// Keycloak owns the membership for a linked identity; an empty claim removes
	// prior memberships so group revocation takes effect on the next login.
	return s.db.SetUserTeam(ctx, userID, team, "")
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
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	logoutToken := ""
	var parseErr error
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "application/json") {
		var body struct {
			LogoutToken string `json:"logout_token"`
		}
		parseErr = json.NewDecoder(r.Body).Decode(&body)
		logoutToken = strings.TrimSpace(body.LogoutToken)
	} else {
		parseErr = r.ParseForm()
		logoutToken = strings.TrimSpace(r.PostForm.Get("logout_token"))
	}
	if parseErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(parseErr, &tooLarge) {
			writeOpenAIError(w, http.StatusRequestEntityTooLarge, "logout request body is too large", "invalid_request_error", "body_too_large")
		} else {
			writeOpenAIError(w, http.StatusBadRequest, "invalid logout request body", "invalid_request_error", "invalid_body")
		}
		return
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
	// A logout token is intended for this RP only when its aud explicitly contains
	// our client ID. azp is not an audience grant and must never substitute for it.
	if !audienceMatches(claims["aud"], s.keycloakConfig().ClientID) {
		writeOpenAIError(w, http.StatusBadRequest, "logout_token audience mismatch", "invalid_request_error", "invalid_token")
		return
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
		users, err := s.db.RevokeAuthSessionsByKeycloakSID(r.Context(), sid)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "logout revocation failed", "server_error", "logout_retry")
			return
		}
		if len(users) > 0 {
			s.auditAuthEvent(r.Context(), "sso_backchannel_logout", users[0], "", "", "keycloak sid="+sid+" sub="+sub)
		}
	} else if id, found, err := s.db.AuthIdentityBySubject(r.Context(), "keycloak", s.keycloakConfig().IssuerURL, sub); err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "logout identity lookup failed", "server_error", "logout_retry")
		return
	} else if found {
		// No sid → log out every session for the subject.
		if err := s.db.RevokeAuthSessionsForUser(r.Context(), id.UserID); err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "logout revocation failed", "server_error", "logout_retry")
			return
		}
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
		users, err := s.db.RevokeAuthSessionsByKeycloakSID(r.Context(), sid)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "logout revocation failed", "server_error", "logout_retry")
			return
		}
		if len(users) > 0 {
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
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		RefreshToken string `json:"refresh_token"`
		IDTokenHint  string `json:"id_token_hint"`
		ReturnTo     string `json:"return_to"`
	}
	if err := decodeKeycloakJSONBody(w, r, &p, true); err != nil {
		writeKeycloakJSONBodyError(w, err, "logout request")
		return
	}
	// Local logout: revoke the entire internal session. Either a valid bearer or a
	// refresh token can identify it; session revocation also invalidates every refresh
	// token in the same transaction.
	claims, claimsOK := s.currentAccessClaims(r)
	if claimsOK && claims.SessionID != "" {
		if err := s.db.RevokeAuthSession(r.Context(), claims.SessionID); err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "internal session logout failed", "server_error", "logout_retry")
			return
		}
	}
	if strings.TrimSpace(p.RefreshToken) != "" {
		rec, found, err := s.db.RefreshTokenByHash(r.Context(), hashProxyKey(p.RefreshToken))
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "internal session lookup failed", "server_error", "logout_retry")
			return
		}
		if found && (!claimsOK || rec.SessionID != claims.SessionID) {
			if err := s.db.RevokeAuthSession(r.Context(), rec.SessionID); err != nil {
				writeOpenAIError(w, http.StatusServiceUnavailable, "internal session logout failed", "server_error", "logout_retry")
				return
			}
		}
	}
	if claimsOK {
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
				returnTo := "/admin"
				if target, ok := safeAuthReturnTo(p.ReturnTo); ok {
					returnTo = target
				}
				base = base[:i] + returnTo
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
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	kc := s.keycloakConfig()
	rec, dbBacked, err := s.storedKeycloakConfig(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "failed to load stored SSO config", "server_error", "sso_config_unavailable")
		return
	}
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
		"version":           rec.Version,
		"note":              "source=db이면 관리자 화면 설정이 우선 적용되며 client secret은 AES-GCM으로 암호화 저장됩니다. db 설정이 없으면 환경변수(SSO_KEYCLOAK_*)가 사용됩니다.",
	})
}

// handleKeycloakConfigSave persists a DB-backed Keycloak provider override. The client secret
// is encrypted at rest (AES-GCM) and never echoed back. An omitted client_secret keeps the
// stored one (so admins can edit other fields without re-entering it); an explicit empty string
// clears it. PUT/POST /admin/sso/keycloak/config
func (s *Server) handleKeycloakConfigSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		w.Header().Set("Allow", "PUT, POST")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
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
		ExpectedVersion *int              `json:"expected_version"`
	}
	if err := decodeKeycloakJSONBody(w, r, &p, false); err != nil {
		writeKeycloakJSONBodyError(w, err, "SSO config request")
		return
	}
	p.IssuerURL = strings.TrimSpace(p.IssuerURL)
	p.ClientID = strings.TrimSpace(p.ClientID)
	p.RedirectURI = strings.TrimSpace(p.RedirectURI)
	// Validation: when enabling, issuer must be an absolute URL and client id present.
	if p.Enabled {
		if !s.cfg.Auth.Enabled || strings.TrimSpace(s.cfg.Auth.JWTSecret) == "" {
			writeOpenAIError(w, http.StatusConflict, "AUTH_ENABLED=true and AUTH_JWT_SECRET are required before enabling SSO", "invalid_request_error", "auth_required_for_sso")
			return
		}
		if !strings.HasPrefix(p.IssuerURL, "https://") && !strings.HasPrefix(p.IssuerURL, "http://") {
			writeOpenAIError(w, http.StatusBadRequest, "issuer_url must be an absolute http(s) URL", "invalid_request_error", "bad_issuer")
			return
		}
		if p.ClientID == "" {
			writeOpenAIError(w, http.StatusBadRequest, "client_id is required when enabling SSO", "invalid_request_error", "bad_client_id")
			return
		}
		if !strings.HasPrefix(p.RedirectURI, "http://") && !strings.HasPrefix(p.RedirectURI, "https://") {
			writeOpenAIError(w, http.StatusBadRequest, "redirect_uri must be an absolute http(s) URL", "invalid_request_error", "bad_redirect")
			return
		}
	}

	prev, found, err := s.storedKeycloakConfig(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "failed to load current SSO config", "server_error", "sso_config_unavailable")
		return
	}
	if p.ExpectedVersion != nil {
		currentVersion := 0
		if found {
			currentVersion = prev.Version
		}
		if *p.ExpectedVersion != currentVersion {
			writeOpenAIError(w, http.StatusConflict, "SSO config changed concurrently; reload before saving", "conflict_error", "sso_config_conflict")
			return
		}
	}
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
		Version:         prev.Version,
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
		if errors.Is(err, store.ErrSSOConfigConflict) {
			writeOpenAIError(w, http.StatusConflict, "SSO config changed concurrently; reload before saving", "conflict_error", "sso_config_conflict")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, "failed to save SSO config: "+err.Error(), "server_error", "save_failed")
		return
	}
	if err := s.reloadKeycloakConfig(r.Context()); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "SSO config was saved but could not be activated", "server_error", "sso_reload_failed")
		return
	}
	// Never log the secret/code; record only the actor + enabled state.
	s.auditAuthEvent(r.Context(), "sso_config_updated", rec.UpdatedBy, "", "", "keycloak enabled="+boolStr(rec.Enabled)+" issuer="+rec.IssuerURL)
	w.WriteHeader(http.StatusNoContent)
}

// handleKeycloakTest diagnoses the Keycloak connection: discovery reachability, endpoints,
// and JWKS key count. Admin-only. POST /admin/sso/keycloak/test
func (s *Server) handleKeycloakTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
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
