package proxy

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

type keycloakCallbackRoundTripper func(*http.Request) (*http.Response, error)

func (f keycloakCallbackRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func installKeycloakCallbackTestGlobals(t *testing.T, disc oidcDiscovery, client *http.Client) {
	t.Helper()
	previousClient := oidcHTTP
	discMu.Lock()
	previousDisc, previousFetch := discCache, discFetch
	discCache, discFetch = disc, time.Now()
	discMu.Unlock()
	oidcHTTP = client
	t.Cleanup(func() {
		oidcHTTP = previousClient
		discMu.Lock()
		discCache, discFetch = previousDisc, previousFetch
		discMu.Unlock()
	})
}

func runKeycloakCallback(t *testing.T, s *Server, state string) *httptest.ResponseRecorder {
	t.Helper()
	s.saveOIDCFlow(t.Context(), state, "callback-nonce", "callback-verifier", "/app/login")
	query := url.Values{}
	query.Set("state", state)
	query.Set("code", "authorization-code-must-not-leak")
	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/callback?"+query.Encode(), nil)
	req.AddCookie(&http.Cookie{Name: oidcStateCookieName, Value: state})
	response := httptest.NewRecorder()
	s.handleKeycloakCallback(response, req)
	return response
}

func assertSanitizedKeycloakCallbackFailure(t *testing.T, db *store.SQLStore, response *httptest.ResponseRecorder, wantCode string, forbidden ...string) {
	t.Helper()
	wantLocation := "/app/login#kc_error=" + wantCode
	if response.Code != http.StatusFound || response.Header().Get("Location") != wantLocation {
		t.Fatalf("callback redirect = %d %q, want %q", response.Code, response.Header().Get("Location"), wantLocation)
	}
	events, err := db.ListAuditEvents(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].EventType != "sso_login_failed" {
		t.Fatalf("missing SSO failure audit event: %+v", events)
	}
	wantDetail := "keycloak code=" + wantCode
	if wantCode == keycloakCallbackErrorProvisioning {
		wantDetail += " stage=" + keycloakProvisioningStageRoleMapping
	}
	if events[0].Detail != wantDetail {
		t.Fatalf("audit detail = %q, want %q", events[0].Detail, wantDetail)
	}
	haystacks := []struct {
		name  string
		value string
	}{
		{name: "Location", value: response.Header().Get("Location")},
		{name: "body", value: response.Body.String()},
		{name: "audit", value: events[0].Detail},
	}
	for _, secret := range forbidden {
		encoded := url.QueryEscape(secret)
		for _, haystack := range haystacks {
			if strings.Contains(haystack.value, secret) || strings.Contains(haystack.value, encoded) {
				t.Fatalf("%s exposed forbidden callback detail %q: %q", haystack.name, secret, haystack.value)
			}
		}
	}
}

func TestTakeOIDCFlowDoesNotReusePersistedMirrorAfterDBMiss(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "durable-" + random

	s.saveOIDCFlow(ctx, state, "nonce", "verifier", "/app/providers")
	// Simulate another pod winning the callback and consuming the durable state. The local
	// in-memory mirror remains until this originating pod observes the healthy DB miss.
	if _, _, _, found, err := db.TakeOIDCFlowState(ctx, state); err != nil || !found {
		t.Fatalf("remote durable take: found=%v err=%v", found, err)
	}
	if _, found := s.takeOIDCFlow(ctx, state); found {
		t.Fatal("a healthy DB miss must not resurrect a persisted in-memory mirror")
	}
	if _, found := takeFlowState(state); found {
		t.Fatal("stale persisted mirror was not removed")
	}
}

func TestTakeOIDCFlowFallsBackAfterDBSaveFailure(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "save-failed-" + random

	saveCtx, cancelSave := context.WithCancel(ctx)
	cancelSave()
	s.saveOIDCFlow(saveCtx, state, "nonce", "verifier", "/app/")

	fs, found := s.takeOIDCFlow(ctx, state)
	if !found {
		t.Fatal("originating pod must retain fallback when the DB save fails")
	}
	if fs.persisted || fs.nonce != "nonce" || fs.verifier != "verifier" || fs.returnTo != "/app/" {
		t.Fatalf("unexpected fallback state: %+v", fs)
	}
}

func TestTakeOIDCFlowFailsClosedForPersistedStateAfterDBReadError(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t)
	s := &Server{db: db}
	random, err := randomURLSafe(8)
	if err != nil {
		t.Fatal(err)
	}
	state := "read-error-" + random

	s.saveOIDCFlow(ctx, state, "nonce", "verifier", "/app/routing")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if _, found := s.takeOIDCFlow(ctx, state); found {
		t.Fatal("a persisted state must fail closed when the DB cannot prove single-use consumption")
	}
	if _, found := takeFlowState(state); found {
		t.Fatal("persisted mirror must be discarded after a DB read error")
	}
}

func TestKeycloakCallbackConsumesBoundStateAndSanitizesProviderError(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: "https://idp.example/realms/vibe",
	}}}
	const state = "browser-bound-provider-error"
	s.saveOIDCFlow(t.Context(), state, "nonce", "verifier", "/app/login")

	req := httptest.NewRequest(http.MethodGet, "/auth/keycloak/callback?state="+state+"&error=access_denied&error_description=do-not-reflect-secret", nil)
	req.AddCookie(&http.Cookie{Name: oidcStateCookieName, Value: state})
	response := httptest.NewRecorder()
	s.handleKeycloakCallback(response, req)

	if response.Code != http.StatusFound || response.Header().Get("Location") != "/app/login#kc_error=access_denied" {
		t.Fatalf("callback redirect = %d %q", response.Code, response.Header().Get("Location"))
	}
	if strings.Contains(response.Header().Get("Location"), "do-not-reflect-secret") {
		t.Fatal("provider error_description was reflected into the redirect")
	}
	assertSanitizedKeycloakCallbackFailure(t, db, response, "access_denied", "do-not-reflect-secret")
	cookies := response.Result().Cookies()
	cleared := false
	for _, cookie := range cookies {
		if cookie.Name == oidcStateCookieName && cookie.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("OIDC state cookie was not cleared")
	}
	if _, found := s.takeOIDCFlow(t.Context(), state); found {
		t.Fatal("provider-error callback did not consume its one-time state")
	}
}

func TestKeycloakCallbackRedactsTokenExchangeErrorFromRedirectBodyAndAudit(t *testing.T) {
	db := openTestStore(t)
	const (
		issuerMarker        = "https://issuer.private.example/realms/customer-a"
		endpointCredential  = "endpoint-query-credential-7391"
		tokenResponseDetail = "token-response-detail-4826"
		piiMarker           = "alice-private@example.invalid"
	)
	disc := oidcDiscovery{
		Issuer:                issuerMarker,
		AuthorizationEndpoint: issuerMarker + "/authorize",
		TokenEndpoint:         issuerMarker + "/token?client_secret=" + endpointCredential,
		JWKSURI:               issuerMarker + "/certs",
	}
	client := &http.Client{Transport: keycloakCallbackRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("POST %s failed: %s for %s", req.URL.String(), tokenResponseDetail, piiMarker)
	})}
	installKeycloakCallbackTestGlobals(t, disc, client)
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: issuerMarker, ClientID: "vibe-coders",
	}}}

	response := runKeycloakCallback(t, s, "token-exchange-redaction")
	assertSanitizedKeycloakCallbackFailure(t, db, response, keycloakCallbackErrorTokenExchange,
		issuerMarker, endpointCredential, tokenResponseDetail, piiMarker)
}

func TestKeycloakCallbackRedactsIDTokenVerificationErrorFromRedirectBodyAndAudit(t *testing.T) {
	db := openTestStore(t)
	const (
		issuerMarker = "https://issuer.private.example/realms/customer-b"
		verifySecret = "Bearer+verification-secret-1937"
	)
	header, err := json.Marshal(map[string]string{"alg": verifySecret, "kid": "untrusted-kid"})
	if err != nil {
		t.Fatal(err)
	}
	malformedIDToken := base64.RawURLEncoding.EncodeToString(header) + ".e30.c2ln"
	disc := oidcDiscovery{
		Issuer:                issuerMarker,
		AuthorizationEndpoint: issuerMarker + "/authorize",
		TokenEndpoint:         issuerMarker + "/token",
		JWKSURI:               issuerMarker + "/certs",
	}
	client := &http.Client{Transport: keycloakCallbackRoundTripper(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"id_token":` + fmt.Sprintf("%q", malformedIDToken) + `}`)),
			Request:    req,
		}, nil
	})}
	installKeycloakCallbackTestGlobals(t, disc, client)
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: issuerMarker, ClientID: "vibe-coders",
	}}}

	response := runKeycloakCallback(t, s, "id-token-redaction")
	assertSanitizedKeycloakCallbackFailure(t, db, response, keycloakCallbackErrorIDToken,
		issuerMarker, verifySecret, "unsupported jwt alg")
}

func TestKeycloakCallbackRedactsProvisioningErrorFromRedirectBodyAndAudit(t *testing.T) {
	db := openTestStore(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const (
		issuerMarker = "https://issuer.private.example/realms/customer-c"
		piiMarker    = "privileged-owner@example.invalid"
		kid          = "provisioning-test-key"
	)
	if err := db.CreateAuthUser(t.Context(), store.AuthUser{
		ID: "existing-privileged-user", Email: piiMarker, PasswordHash: "password-hash",
		Name: "Existing User", Role: "admin", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	idToken := signRS256(t, key, kid, map[string]any{
		"iss": issuerMarker, "aud": "vibe-coders", "sub": "new-subject",
		"nonce": "callback-nonce", "exp": float64(time.Now().Add(time.Hour).Unix()),
		"email": piiMarker, "email_verified": true,
	})
	disc := oidcDiscovery{
		Issuer:                issuerMarker,
		AuthorizationEndpoint: issuerMarker + "/authorize",
		TokenEndpoint:         issuerMarker + "/token",
		JWKSURI:               issuerMarker + "/certs",
	}
	client := &http.Client{Transport: keycloakCallbackRoundTripper(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"id_token":` + fmt.Sprintf("%q", idToken) + `}`)),
			Request:    req,
		}, nil
	})}
	installKeycloakCallbackTestGlobals(t, disc, client)
	jwksMu.Lock()
	previousJWKS := jwksCache
	jwksCache = map[string]jwksCacheEntry{
		issuerMarker + "\x00" + disc.JWKSURI: {keys: map[string]*rsa.PublicKey{kid: &key.PublicKey}, fetched: time.Now()},
	}
	jwksMu.Unlock()
	t.Cleanup(func() {
		jwksMu.Lock()
		jwksCache = previousJWKS
		jwksMu.Unlock()
	})
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: issuerMarker, ClientID: "vibe-coders",
	}}}

	response := runKeycloakCallback(t, s, "provisioning-redaction")
	assertSanitizedKeycloakCallbackFailure(t, db, response, keycloakCallbackErrorProvisioning,
		issuerMarker, piiMarker, "no role mapping matched")
}

func TestKeycloakCallbackSuccessStillReturnsOneTimeExchangeCode(t *testing.T) {
	db := openTestStore(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const (
		issuer       = "https://issuer.example/realms/success"
		kid          = "success-test-key"
		accessToken  = "provider-access-token-must-not-leak"
		refreshToken = "provider-refresh-token-must-not-leak"
	)
	idToken := signRS256(t, key, kid, map[string]any{
		"iss": issuer, "aud": "vibe-coders", "sub": "successful-subject",
		"nonce": "callback-nonce", "exp": float64(time.Now().Add(time.Hour).Unix()),
	})
	disc := oidcDiscovery{
		Issuer:                issuer,
		AuthorizationEndpoint: issuer + "/authorize",
		TokenEndpoint:         issuer + "/token",
		JWKSURI:               issuer + "/certs",
	}
	client := &http.Client{Transport: keycloakCallbackRoundTripper(func(req *http.Request) (*http.Response, error) {
		payload, err := json.Marshal(keycloakTokenResponse{
			AccessToken: accessToken, IDToken: idToken, RefreshToken: refreshToken,
		})
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(string(payload))), Request: req,
		}, nil
	})}
	installKeycloakCallbackTestGlobals(t, disc, client)
	jwksMu.Lock()
	previousJWKS := jwksCache
	jwksCache = map[string]jwksCacheEntry{
		issuer + "\x00" + disc.JWKSURI: {keys: map[string]*rsa.PublicKey{kid: &key.PublicKey}, fetched: time.Now()},
	}
	jwksMu.Unlock()
	t.Cleanup(func() {
		jwksMu.Lock()
		jwksCache = previousJWKS
		jwksMu.Unlock()
	})
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, IssuerURL: issuer, ClientID: "vibe-coders", DefaultRole: "developer",
	}}}

	response := runKeycloakCallback(t, s, "successful-callback")
	location := response.Header().Get("Location")
	if response.Code != http.StatusFound || !strings.HasPrefix(location, "/app/login#kc_code=") {
		t.Fatalf("successful callback redirect = %d %q", response.Code, location)
	}
	for _, secret := range []string{accessToken, refreshToken, idToken} {
		if strings.Contains(location, secret) || strings.Contains(response.Body.String(), secret) {
			t.Fatalf("successful callback exposed provider token %q", secret)
		}
	}
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	exchangeCode := fragment.Get("kc_code")
	if exchangeCode == "" || fragment.Get("kc_error") != "" {
		t.Fatalf("unexpected callback fragment %q", parsed.Fragment)
	}
	exchange, found, err := db.TakeOIDCLoginExchange(t.Context(), hashProxyKey(exchangeCode))
	if err != nil || !found || exchange.UserID == "" {
		t.Fatalf("one-time callback exchange not persisted: found=%v exchange=%+v err=%v", found, exchange, err)
	}
	if _, found, err := db.TakeOIDCLoginExchange(t.Context(), hashProxyKey(exchangeCode)); err != nil || found {
		t.Fatalf("callback exchange was reusable: found=%v err=%v", found, err)
	}
}

func TestStableKeycloakCallbackErrorCodeRejectsUnboundedOrUnexpectedValues(t *testing.T) {
	for _, raw := range []string{
		"credential=" + strings.Repeat("x", 1024),
		"temporarily_unavailable&client_secret=exposed",
		"unknown_provider_error",
	} {
		if got := stableKeycloakCallbackErrorCode(raw); got != keycloakCallbackErrorUnexpected {
			t.Errorf("stableKeycloakCallbackErrorCode(%q) = %q", raw, got)
		}
	}
	if len(stableKeycloakCallbackErrorCode(strings.Repeat("x", 4096))) > 64 {
		t.Fatal("browser-visible Keycloak error code is not bounded")
	}
}
