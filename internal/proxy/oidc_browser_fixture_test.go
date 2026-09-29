//go:build linux

package proxy

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const browserOIDCCookie = "vibe_browser_fixture"

type browserOIDCGrant struct {
	redirect, state, nonce, challenge, binding string
	expires                                    time.Time
}

// This test-only IdP deliberately has no end-session endpoint. Loopback HTTP
// covers gateway logout, not HTTPS cross-origin RP-initiated IdP logout.
type browserOIDCFixture struct {
	server                           *httptest.Server
	key                              *rsa.PrivateKey
	clientID, clientSecret, redirect string
	redirectOrigin                   string
	email, password                  string
	mu                               sync.Mutex
	pending, codes                   map[string]browserOIDCGrant
}

func browserFixtureSecret(t *testing.T) string {
	t.Helper()
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal("synthetic fixture entropy unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(value[:])
}

func newBrowserOIDCFixture(t *testing.T, redirect string) *browserOIDCFixture {
	t.Helper()
	redirectOrigin, err := browserOIDCRedirectOrigin(redirect)
	if err != nil {
		t.Fatal("fixture requires a registered loopback gateway callback")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal("synthetic signing key could not be created")
	}
	f := &browserOIDCFixture{
		key: key, clientID: "vibe-auth-browser", clientSecret: browserFixtureSecret(t), redirect: redirect, redirectOrigin: redirectOrigin,
		email: "sso-browser@example.invalid", password: browserFixtureSecret(t),
		pending: map[string]browserOIDCGrant{}, codes: map[string]browserOIDCGrant{},
	}
	f.server = httptest.NewUnstartedServer(http.HandlerFunc(f.serveHTTP))
	f.server.Config.ErrorLog = log.New(io.Discard, "", 0)
	f.server.Config.ReadHeaderTimeout = 3 * time.Second
	f.server.Config.ReadTimeout = 5 * time.Second
	f.server.Config.WriteTimeout = 5 * time.Second
	f.server.Start()
	t.Cleanup(func() {
		f.server.CloseClientConnections()
		f.server.Close()
		f.mu.Lock()
		clear(f.pending)
		clear(f.codes)
		f.mu.Unlock()
	})
	return f
}

func browserOIDCRedirectOrigin(redirect string) (string, error) {
	target, err := url.Parse(redirect)
	if err != nil || target.Scheme != "http" || target.User != nil || target.RawQuery != "" || target.Fragment != "" ||
		target.Path != "/auth/keycloak/callback" || !net.ParseIP(target.Hostname()).IsLoopback() || target.Port() == "" {
		return "", errors.New("invalid fixture callback")
	}
	return target.Scheme + "://" + target.Host, nil
}

func (f *browserOIDCFixture) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer": f.server.URL, "authorization_endpoint": f.server.URL + "/authorize",
			"token_endpoint": f.server.URL + "/token", "jwks_uri": f.server.URL + "/jwks",
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"token_endpoint_auth_methods_supported": []string{"client_secret_post"},
			"code_challenge_methods_supported":      []string{"S256"},
		})
	case "/jwks":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"keys": []any{map[string]string{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "browser-fixture",
			"n": base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes()),
		}}})
	case "/authorize":
		if r.Method == http.MethodGet {
			f.authorize(w, r)
		} else if r.Method == http.MethodPost {
			f.login(w, r)
		} else {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case "/token":
		f.exchange(w, r)
	default:
		http.NotFound(w, r)
	}
}

var browserPKCEChallenge = regexp.MustCompile("^[A-Za-z0-9_-]{43}$")
var browserPKCEVerifier = regexp.MustCompile("^[A-Za-z0-9._~-]{43,128}$")
var regexpBrowserRequestID = regexp.MustCompile("name=\"request_id\" value=\"([^\"]+)\"")

func (f *browserOIDCFixture) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for _, key := range []string{"client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"} {
		if len(q[key]) != 1 || q.Get(key) == "" || len(q.Get(key)) > 2048 {
			http.Error(w, "invalid authorization request", http.StatusBadRequest)
			return
		}
	}
	if q.Get("client_id") != f.clientID || q.Get("redirect_uri") != f.redirect || q.Get("response_type") != "code" ||
		!containsString(strings.Fields(q.Get("scope")), "openid") || q.Get("code_challenge_method") != "S256" ||
		!browserPKCEChallenge.MatchString(q.Get("code_challenge")) {
		http.Error(w, "invalid authorization request", http.StatusBadRequest)
		return
	}
	if q.Get("prompt") == "none" {
		target, _ := url.Parse(f.redirect)
		query := target.Query()
		query.Set("state", q.Get("state"))
		query.Set("error", "login_required")
		target.RawQuery = query.Encode()
		http.Redirect(w, r, target.String(), http.StatusFound)
		return
	}
	requestID, binding, ok := browserFixturePair()
	if !ok {
		http.Error(w, "fixture unavailable", http.StatusServiceUnavailable)
		return
	}
	f.mu.Lock()
	f.pruneLocked()
	if len(f.pending)+len(f.codes) >= 128 {
		f.mu.Unlock()
		http.Error(w, "fixture capacity reached", http.StatusServiceUnavailable)
		return
	}
	f.pending[requestID] = browserOIDCGrant{
		redirect: f.redirect, state: q.Get("state"), nonce: q.Get("nonce"), challenge: q.Get("code_challenge"),
		binding: binding, expires: time.Now().Add(2 * time.Minute),
	}
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: browserOIDCCookie, Value: binding, Path: "/authorize", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 120})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Chromium applies form-action to the POST's redirect chain. Permit only the
	// registered gateway origin, while the exact callback remains bound below.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self' "+f.redirectOrigin+"; frame-ancestors 'none'; base-uri 'none'")
	_ = browserOIDCLoginPage.Execute(w, requestID)
}

var browserOIDCLoginPage = template.Must(template.New("login").Parse("<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><title>OIDC 테스트 로그인</title><h1>OIDC 테스트 로그인</h1><form method=\"post\" action=\"/authorize\"><input type=\"hidden\" name=\"request_id\" value=\"{{.}}\"><label for=\"email\">이메일</label><input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"username\" required><label for=\"password\">비밀번호</label><input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required><button type=\"submit\">테스트 계정으로 로그인</button></form></html>"))

func browserFixturePair() (string, string, bool) {
	var value [64]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", "", false
	}
	return base64.RawURLEncoding.EncodeToString(value[:32]), base64.RawURLEncoding.EncodeToString(value[32:]), true
}

func (f *browserOIDCFixture) pruneLocked() {
	for _, entries := range []map[string]browserOIDCGrant{f.pending, f.codes} {
		for key, grant := range entries {
			if !time.Now().Before(grant.expires) {
				delete(entries, key)
			}
		}
	}
}

func (f *browserOIDCFixture) login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if r.ParseForm() != nil {
		http.Error(w, "invalid login request", http.StatusBadRequest)
		return
	}
	cookie, err := r.Cookie(browserOIDCCookie)
	f.mu.Lock()
	grant, found := f.pending[r.PostForm.Get("request_id")]
	delete(f.pending, r.PostForm.Get("request_id"))
	f.mu.Unlock()
	if err != nil || !found || !time.Now().Before(grant.expires) ||
		subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(grant.binding)) != 1 ||
		r.PostForm.Get("email") != f.email || subtle.ConstantTimeCompare([]byte(r.PostForm.Get("password")), []byte(f.password)) != 1 {
		http.Error(w, "invalid login request", http.StatusUnauthorized)
		return
	}
	code, _, ok := browserFixturePair()
	if !ok {
		http.Error(w, "fixture unavailable", http.StatusServiceUnavailable)
		return
	}
	f.mu.Lock()
	f.codes[code] = grant
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: browserOIDCCookie, Value: "", Path: "/authorize", HttpOnly: true, MaxAge: -1})
	target, _ := url.Parse(grant.redirect)
	query := target.Query()
	query.Set("code", code)
	query.Set("state", grant.state)
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (f *browserOIDCFixture) exchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if r.ParseForm() != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	p := r.PostForm
	f.mu.Lock()
	grant, found := f.codes[p.Get("code")]
	delete(f.codes, p.Get("code")) // A code has exactly one redemption attempt.
	f.mu.Unlock()
	digest := sha256.Sum256([]byte(p.Get("code_verifier")))
	if !found || !time.Now().Before(grant.expires) || p.Get("grant_type") != "authorization_code" ||
		p.Get("client_id") != f.clientID || p.Get("redirect_uri") != grant.redirect ||
		subtle.ConstantTimeCompare([]byte(p.Get("client_secret")), []byte(f.clientSecret)) != 1 ||
		!browserPKCEVerifier.MatchString(p.Get("code_verifier")) ||
		subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(digest[:])), []byte(grant.challenge)) != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	token, err := f.idToken(grant.nonce)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "server_error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id_token": token, "access_token": "fixture-unused-access", "token_type": "Bearer", "expires_in": 120})
}

func (f *browserOIDCFixture) idToken(nonce string) (string, error) {
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "browser-fixture", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": f.server.URL, "sub": "browser-sso-subject", "aud": f.clientID,
		"iat": time.Now().Unix(), "exp": time.Now().Add(2 * time.Minute).Unix(), "nonce": nonce,
		"email": f.email, "email_verified": true, "preferred_username": "browser-sso",
		"name": "브라우저 SSO 테스트", "sid": "browser-idp-session",
		"realm_access": map[string]any{"roles": []string{"browser-admin"}}, "groups": []string{"/teams/browser-team"},
	})
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func browserOIDCTestClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal("fixture cookie jar unavailable")
	}
	return &http.Client{Jar: jar, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func browserOIDCTestCode(t *testing.T, f *browserOIDCFixture, client *http.Client, verifier, nonce string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"client_id": {f.clientID}, "redirect_uri": {f.redirect}, "response_type": {"code"}, "scope": {"openid profile email"},
		"state": {"fixture-state"}, "nonce": {nonce}, "code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])}, "code_challenge_method": {"S256"},
	}
	response, err := client.Get(f.server.URL + "/authorize?" + query.Encode())
	if err != nil {
		t.Fatal("fixture authorization request failed")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 8192))
	response.Body.Close()
	match := regexpBrowserRequestID.FindSubmatch(data)
	if readErr != nil || response.StatusCode != 200 || len(match) != 2 {
		t.Fatal("fixture login page was unavailable")
	}
	response, err = client.PostForm(f.server.URL+"/authorize", url.Values{"request_id": {string(match[1])}, "email": {f.email}, "password": {f.password}})
	if err != nil {
		t.Fatal("fixture login request failed")
	}
	response.Body.Close()
	target, err := response.Location()
	if response.StatusCode != 302 || err != nil || target.Query().Get("state") != "fixture-state" || target.Query().Get("code") == "" {
		t.Fatal("fixture did not issue a bound authorization redirect")
	}
	return target.Query().Get("code")
}

func TestBrowserOIDCFixtureValidatesCodeBindings(t *testing.T) {
	f := newBrowserOIDCFixture(t, "http://127.0.0.1:32123/auth/keycloak/callback")
	client := browserOIDCTestClient(t)
	for _, mode := range []string{"valid", "verifier", "redirect", "client", "secret", "expired"} {
		t.Run(mode, func(t *testing.T) {
			verifier, nonce := browserFixtureSecret(t), browserFixtureSecret(t)
			code := browserOIDCTestCode(t, f, client, verifier, nonce)
			form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {f.redirect}, "client_id": {f.clientID}, "client_secret": {f.clientSecret}}
			switch mode {
			case "verifier":
				form.Set("code_verifier", browserFixtureSecret(t))
			case "redirect":
				form.Set("redirect_uri", "http://127.0.0.1:1/other")
			case "client":
				form.Set("client_id", "different-client")
			case "secret":
				form.Set("client_secret", "invalid-secret")
			case "expired":
				f.mu.Lock()
				grant := f.codes[code]
				grant.expires = time.Now().Add(-time.Second)
				f.codes[code] = grant
				f.mu.Unlock()
			}
			response, err := client.PostForm(f.server.URL+"/token", form)
			if err != nil {
				t.Fatal("fixture token request failed")
			}
			var tokens map[string]any
			decodeErr := json.NewDecoder(response.Body).Decode(&tokens)
			response.Body.Close()
			if decodeErr != nil {
				t.Fatal("fixture token response was not JSON")
			}
			if mode == "valid" {
				raw, ok := tokens["id_token"].(string)
				if response.StatusCode != 200 || !ok {
					t.Fatal("valid authorization code did not yield an ID token")
				}
				server := &Server{cfg: browserFixtureConfig(f)}
				disc, err := keycloakDiscover(t.Context(), f.server.URL)
				if err != nil {
					t.Fatal("real discovery failed")
				}
				claims, err := server.verifyKeycloakIDToken(t.Context(), disc, raw, nonce)
				if err != nil || claims["sub"] != "browser-sso-subject" || claims["nonce"] != nonce {
					t.Fatal("RS256 signature/issuer/audience/nonce validation failed")
				}
				if _, err := server.verifyKeycloakIDToken(t.Context(), disc, raw, "different-nonce"); err == nil {
					t.Fatal("real verifier accepted a wrong nonce")
				}
			} else if response.StatusCode != 400 || tokens["error"] != "invalid_grant" {
				t.Fatal("fixture accepted an invalid code binding")
			}
			response, err = client.PostForm(f.server.URL+"/token", form)
			if err != nil {
				t.Fatal("fixture replay request failed")
			}
			response.Body.Close()
			if response.StatusCode != 400 {
				t.Fatal("fixture accepted a consumed authorization code")
			}
		})
	}
}

func TestBrowserOIDCFixtureRejectsUnregisteredAuthorization(t *testing.T) {
	f := newBrowserOIDCFixture(t, "http://127.0.0.1:32123/auth/keycloak/callback")
	client := browserOIDCTestClient(t)
	digest := sha256.Sum256([]byte(browserFixtureSecret(t)))
	for _, mode := range []string{"redirect", "client", "nonce", "method", "challenge"} {
		t.Run(mode, func(t *testing.T) {
			query := url.Values{
				"client_id": {f.clientID}, "redirect_uri": {f.redirect}, "response_type": {"code"}, "scope": {"openid"},
				"state": {"state"}, "nonce": {"nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])}, "code_challenge_method": {"S256"},
			}
			switch mode {
			case "redirect":
				query.Set("redirect_uri", "https://unregistered.example.invalid/callback")
			case "client":
				query.Set("client_id", "unknown")
			case "nonce":
				query.Del("nonce")
			case "method":
				query.Set("code_challenge_method", "plain")
			case "challenge":
				query.Set("code_challenge", "invalid")
			}
			response, err := client.Get(f.server.URL + "/authorize?" + query.Encode())
			if err != nil {
				t.Fatal("fixture invalid authorization request failed")
			}
			response.Body.Close()
			if response.StatusCode != 400 || response.Header.Get("Location") != "" {
				t.Fatal("fixture reflected an unregistered authorization redirect")
			}
		})
	}
}

func TestBrowserOIDCFixtureRequiresBrowserAndCredentials(t *testing.T) {
	f := newBrowserOIDCFixture(t, "http://127.0.0.1:32123/auth/keycloak/callback")
	for _, mode := range []string{"missing-cookie", "wrong-password", "expired-request"} {
		t.Run(mode, func(t *testing.T) {
			client := browserOIDCTestClient(t)
			query := url.Values{
				"client_id": {f.clientID}, "redirect_uri": {f.redirect}, "response_type": {"code"}, "scope": {"openid"},
				"state": {"state"}, "nonce": {"nonce"}, "code_challenge": {browserFixtureSecret(t)}, "code_challenge_method": {"S256"},
			}
			response, err := client.Get(f.server.URL + "/authorize?" + query.Encode())
			if err != nil {
				t.Fatal("fixture login page request failed")
			}
			page, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
			response.Body.Close()
			match := regexpBrowserRequestID.FindSubmatch(page)
			if response.StatusCode != 200 || len(match) != 2 {
				t.Fatal("fixture login page missing its request binding")
			}
			expectedPolicy := "default-src 'none'; form-action 'self' " + f.redirectOrigin + "; frame-ancestors 'none'; base-uri 'none'"
			if response.Header.Get("Content-Security-Policy") != expectedPolicy {
				t.Fatal("fixture form redirect policy is not restricted to its registered gateway origin")
			}
			form := url.Values{"request_id": {string(match[1])}, "email": {f.email}, "password": {f.password}}
			switch mode {
			case "missing-cookie":
				client = browserOIDCTestClient(t)
			case "wrong-password":
				form.Set("password", "incorrect-synthetic-password")
			case "expired-request":
				f.mu.Lock()
				grant := f.pending[string(match[1])]
				grant.expires = time.Now().Add(-time.Second)
				f.pending[string(match[1])] = grant
				f.mu.Unlock()
			}
			response, err = client.PostForm(f.server.URL+"/authorize", form)
			if err != nil {
				t.Fatal("fixture invalid login request failed")
			}
			response.Body.Close()
			if response.StatusCode != 401 || response.Header.Get("Location") != "" {
				t.Fatal("fixture issued a code without valid browser/credential binding")
			}
		})
	}
}

func TestBrowserOIDCFixtureRejectsUntrustedCallbackOrigins(t *testing.T) {
	for _, target := range []string{
		"https://outside.example.invalid/auth/keycloak/callback",
		"http://127.0.0.1/auth/keycloak/callback",
		"http://user:synthetic-password@127.0.0.1:1234/auth/keycloak/callback",
		"http://127.0.0.1:1234/not-the-callback",
		"http://127.0.0.1:1234/auth/keycloak/callback?credential=synthetic",
		"http://127.0.0.1:1234/auth/keycloak/callback#fragment",
		"not a URL",
	} {
		if origin, err := browserOIDCRedirectOrigin(target); err == nil || origin != "" {
			t.Fatal("fixture accepted an untrusted callback policy origin")
		}
	}
	for _, target := range []string{"http://127.0.0.1:1234/auth/keycloak/callback", "http://[::1]:1234/auth/keycloak/callback"} {
		origin, err := browserOIDCRedirectOrigin(target)
		if err != nil || origin+"/auth/keycloak/callback" != target {
			t.Fatal("fixture rejected a valid exact loopback callback")
		}
	}
}
