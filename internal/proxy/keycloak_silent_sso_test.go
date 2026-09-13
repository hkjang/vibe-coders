package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// Silent SSO (OIDC prompt=none) must never loop: the server only honours prompt=none while
// auto_login is on, and a declined silent attempt lands on the login screen carrying a
// marker the console reads as "do not try again".

func newSilentSsoTestServer(t *testing.T, autoLogin bool) (*Server, *store.SQLStore) {
	t.Helper()
	const issuer = "https://idp.example/realms/vibe"
	installKeycloakCallbackTestGlobals(t, oidcDiscovery{
		Issuer:                issuer,
		AuthorizationEndpoint: issuer + "/protocol/openid-connect/auth",
		TokenEndpoint:         issuer + "/protocol/openid-connect/token",
		JWKSURI:               issuer + "/protocol/openid-connect/certs",
	}, &http.Client{})
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: issuer, ClientID: "vibe-console",
		RedirectURI: "https://gateway.example/auth/keycloak/callback",
		Scopes:      []string{"openid", "profile", "email"},
		AutoLogin:   autoLogin,
	}}}
	return s, db
}

func startKeycloakLogin(t *testing.T, s *Server, rawQuery string) (authorize *url.URL, state string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/login?"+rawQuery, nil)
	response := httptest.NewRecorder()
	s.handleKeycloakLogin(response, req)
	if response.Code != http.StatusFound {
		t.Fatalf("login status = %d body=%s", response.Code, response.Body.String())
	}
	authorize, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return authorize, authorize.Query().Get("state")
}

func TestKeycloakLoginIgnoresPromptNoneWhileAutoLoginIsOff(t *testing.T) {
	s, _ := newSilentSsoTestServer(t, false)

	authorize, state := startKeycloakLogin(t, s, "prompt=none&return_to=/app/overview")
	if _, has := authorize.Query()["prompt"]; has {
		t.Fatalf("prompt=none was forwarded although auto_login is off: %s", authorize)
	}
	fs, found := s.takeOIDCFlow(t.Context(), state)
	if !found || fs.silent {
		t.Fatalf("flow state = %+v found=%v, want a non-silent flow", fs, found)
	}
}

func TestKeycloakLoginForwardsPromptNoneWhenAutoLoginIsOn(t *testing.T) {
	s, _ := newSilentSsoTestServer(t, true)

	authorize, state := startKeycloakLogin(t, s, "prompt=none&return_to=/app/traces/abc")
	if got := authorize.Query().Get("prompt"); got != "none" {
		t.Fatalf("prompt = %q, want none: %s", got, authorize)
	}
	if authorize.Query().Get("response_type") != "code" || authorize.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("silent attempt dropped the normal PKCE parameters: %s", authorize)
	}
	fs, found := s.takeOIDCFlow(t.Context(), state)
	if !found || !fs.silent || fs.returnTo != "/app/traces/abc" {
		t.Fatalf("flow state = %+v found=%v, want silent with deep link preserved", fs, found)
	}

	// Without prompt=none the very same configuration still starts an ordinary login.
	authorize, state = startKeycloakLogin(t, s, "return_to=/app/overview")
	if _, has := authorize.Query()["prompt"]; has {
		t.Fatalf("ordinary login must not carry prompt: %s", authorize)
	}
	if fs, found := s.takeOIDCFlow(t.Context(), state); !found || fs.silent {
		t.Fatalf("ordinary flow state = %+v found=%v", fs, found)
	}
}

func runSilentCallback(t *testing.T, s *Server, state, returnTo string, silent bool, providerError string) *httptest.ResponseRecorder {
	t.Helper()
	s.saveOIDCFlow(t.Context(), state, "nonce", "verifier", returnTo, silent)
	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/callback?state="+state+"&error="+providerError+"&error_description=not-logged-in-secret", nil)
	req.AddCookie(&http.Cookie{Name: oidcStateCookieName, Value: state})
	response := httptest.NewRecorder()
	s.handleKeycloakCallback(response, req)
	if response.Code != http.StatusFound {
		t.Fatalf("callback status = %d body=%s", response.Code, response.Body.String())
	}
	return response
}

func TestKeycloakCallbackRoutesDeclinedSilentAttemptToLoginWithMarker(t *testing.T) {
	s, db := newSilentSsoTestServer(t, true)

	for _, providerError := range []string{"login_required", "interaction_required", "consent_required"} {
		state := "silent-" + providerError
		response := runSilentCallback(t, s, state, "/app/traces/abc?tab=spans", true, providerError)
		location, err := url.Parse(response.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if location.Path != "/app/login" || location.Query().Get("sso") != "none" || location.Fragment != "" {
			t.Fatalf("%s: redirect = %q, want /app/login?sso=none without an error fragment", providerError, location)
		}
		if got := location.Query().Get("return_to"); got != "/app/traces/abc?tab=spans" {
			t.Fatalf("%s: return_to = %q, deep link was lost", providerError, got)
		}
		if strings.Contains(response.Header().Get("Location"), "not-logged-in-secret") {
			t.Fatal("provider error_description was reflected into the redirect")
		}
		if _, found := s.takeOIDCFlow(t.Context(), state); found {
			t.Fatalf("%s: declined silent attempt did not consume its one-time state", providerError)
		}
	}
	// "Not signed in" is the ordinary answer to prompt=none, not a login failure.
	events, err := db.ListAuditEvents(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.EventType == "sso_login_failed" {
			t.Fatalf("declined silent attempt was audited as a failure: %+v", event)
		}
	}
}

func TestKeycloakCallbackSilentAttemptOtherErrorsStillStopRetries(t *testing.T) {
	s, db := newSilentSsoTestServer(t, true)

	response := runSilentCallback(t, s, "silent-denied", "/app/overview", true, "access_denied")
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Path != "/app/login" || location.Query().Get("sso") != "error" || location.Fragment != "kc_error=access_denied" {
		t.Fatalf("redirect = %q, want /app/login?sso=error#kc_error=access_denied", location)
	}
	events, err := db.ListAuditEvents(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].EventType != "sso_login_failed" || events[0].Detail != "keycloak code=access_denied silent=true" {
		t.Fatalf("audit = %+v, want a sanitized sso_login_failed record", events)
	}

	// An unlisted provider error collapses to the stable provider code, including a string
	// that happens to spell one of our own internal codes.
	for _, odd := range []string{"server_error", keycloakCallbackErrorTokenExchange} {
		response = runSilentCallback(t, s, "silent-odd-"+odd, "/app/overview", true, odd)
		if got := response.Header().Get("Location"); !strings.HasSuffix(got, "#kc_error="+keycloakCallbackErrorProvider) || !strings.Contains(got, "sso=error") {
			t.Fatalf("%s: redirect = %q", odd, got)
		}
	}
}

func TestKeycloakCallbackNonSilentLoginRequiredKeepsLegacyErrorRedirect(t *testing.T) {
	s, _ := newSilentSsoTestServer(t, true)

	response := runSilentCallback(t, s, "plain-login-required", "/app/login", false, "login_required")
	if got := response.Header().Get("Location"); got != "/app/login#kc_error=login_required" {
		t.Fatalf("redirect = %q, want the ordinary error fragment for a non-silent flow", got)
	}
}

func TestSilentSsoLoginRedirect(t *testing.T) {
	cases := map[string]struct{ returnTo, outcome, want string }{
		"deep link":             {"/app/traces/abc?tab=spans", "none", "/app/login?return_to=%2Fapp%2Ftraces%2Fabc%3Ftab%3Dspans&sso=none"},
		"console root":          {"/app/", "none", "/app/login?sso=none"},
		"login page itself":     {"/app/login", "none", "/app/login?sso=none"},
		"login page with query": {"/app/login?return_to=%2Fapp%2Fx", "none", "/app/login?sso=none"},
		"legacy admin":          {"/admin", "none", "/admin?sso=none"},
		"error outcome":         {"/app/overview", "error", "/app/login?return_to=%2Fapp%2Foverview&sso=error"},
	}
	for name, tc := range cases {
		if got := silentSsoLoginRedirect(tc.returnTo, tc.outcome); got != tc.want {
			t.Errorf("%s: silentSsoLoginRedirect(%q,%q) = %q, want %q", name, tc.returnTo, tc.outcome, got, tc.want)
		}
	}
}

func TestSSOStatusAndBootstrapPublishAutoLoginOnlyWhenSsoIsEnabled(t *testing.T) {
	s, _ := newSilentSsoTestServer(t, true)
	req := httptest.NewRequest(http.MethodGet, "/auth/sso/status", nil)
	response := httptest.NewRecorder()
	s.handleSSOStatus(response, req)
	if !strings.Contains(response.Body.String(), `"auto_login":true`) {
		t.Fatalf("status = %s, want auto_login true", response.Body.String())
	}

	s.cfg.Keycloak.Enabled = false
	response = httptest.NewRecorder()
	s.handleSSOStatus(response, req)
	if !strings.Contains(response.Body.String(), `"auto_login":false`) {
		t.Fatalf("status = %s, want auto_login false while SSO is disabled", response.Body.String())
	}
}
