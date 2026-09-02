package proxy

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestResolveKeycloakRole(t *testing.T) {
	cases := []struct {
		roles []string
		def   string
		want  string
	}{
		{[]string{"vibe-developer"}, "developer", "developer"},
		{[]string{"vibe-admin", "vibe-developer"}, "developer", "admin"}, // highest rank wins
		{[]string{"vibe-team-admin", "vibe-auditor"}, "developer", "team_admin"},
		{[]string{"unknown-role"}, "developer", "developer"}, // fallback default
		{[]string{"unknown-role"}, "", ""},                   // no default → block
		{[]string{"vibe-auditor"}, "developer", "readonly_admin"},
	}
	for i, c := range cases {
		if got := resolveKeycloakRole(c.roles, c.def); got != c.want {
			t.Errorf("case %d: resolveKeycloakRole(%v, %q) = %q, want %q", i, c.roles, c.def, got, c.want)
		}
	}
}

// resolveKeycloakRoleExplicit distinguishes an explicit claim mapping from the configured
// fallback for diagnostics; either result is authoritative for a linked SSO identity.
func TestResolveKeycloakRoleExplicit(t *testing.T) {
	cases := []struct {
		roles        []string
		def          string
		wantRole     string
		wantExplicit bool
	}{
		{[]string{"vibe-admin"}, "developer", "admin", true},        // explicit match
		{[]string{"unknown-role"}, "developer", "developer", false}, // default fallback (must not overwrite role)
		{[]string{}, "developer", "developer", false},               // no roles → fallback
		{[]string{"unknown-role"}, "", "", false},                   // no default → block
	}
	for i, c := range cases {
		role, explicit := resolveKeycloakRoleExplicit(nil, c.roles, c.def)
		if role != c.wantRole || explicit != c.wantExplicit {
			t.Errorf("case %d: got (%q,%v), want (%q,%v)", i, role, explicit, c.wantRole, c.wantExplicit)
		}
	}
}

func TestKeycloakTeamFromGroups(t *testing.T) {
	if got := keycloakTeamFromGroups([]string{"/other", "/teams/ai-platform"}); got != "ai-platform" {
		t.Errorf("team = %q, want ai-platform", got)
	}
	if got := keycloakTeamFromGroups([]string{"/teams/data-platform/sub"}); got != "data-platform" {
		t.Errorf("nested team = %q, want data-platform", got)
	}
	if got := keycloakTeamFromGroups([]string{"/nope"}); got != "" {
		t.Errorf("no team group should be empty, got %q", got)
	}
}

func TestClaimStringsAndRoles(t *testing.T) {
	claims := map[string]any{
		"realm_access": map[string]any{"roles": []any{"vibe-admin", "offline_access"}},
		"resource_access": map[string]any{
			"vibe-coders": map[string]any{"roles": []any{"vibe-developer"}},
		},
		"groups": []any{"/teams/ai-platform"},
	}
	if got := claimStrings(claims, "realm_access.roles"); len(got) != 2 || got[0] != "vibe-admin" {
		t.Fatalf("realm roles = %v", got)
	}
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{ClientID: "vibe-coders", RoleClaim: "realm_access.roles"}}}
	roles := s.keycloakRolesFromClaims(claims)
	// realm + client roles merged.
	hasAdmin, hasDev := false, false
	for _, r := range roles {
		if r == "vibe-admin" {
			hasAdmin = true
		}
		if r == "vibe-developer" {
			hasDev = true
		}
	}
	if !hasAdmin || !hasDev {
		t.Fatalf("expected realm+client roles, got %v", roles)
	}
}

// signRS256 builds a signed RS256 JWT for testing.
func signRS256(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signing := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestVerifyKeycloakIDToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	// Seed the JWKS cache so verification doesn't hit the network.
	jwksMu.Lock()
	jwksCache = map[string]jwksCacheEntry{
		"https://kc.example.com/realms/vibe\x00http://unused": {keys: map[string]*rsa.PublicKey{"test-kid": &key.PublicKey}, fetched: time.Now()},
	}
	jwksMu.Unlock()

	const issuer = "https://kc.example.com/realms/vibe"
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{ClientID: "vibe-coders", IssuerURL: issuer}}}
	disc := oidcDiscovery{Issuer: issuer, JWKSURI: "http://unused"}

	base := map[string]any{
		"iss": issuer, "aud": "vibe-coders", "sub": "u-123", "email": "dev@x.com",
		"nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix()),
	}
	tok := signRS256(t, key, "test-kid", base)
	claims, err := s.verifyKeycloakIDToken(t.Context(), disc, tok, "N1")
	if err != nil || claims["sub"] != "u-123" {
		t.Fatalf("valid token should verify: claims=%v err=%v", claims, err)
	}

	// nonce mismatch.
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, tok, "WRONG"); err == nil {
		t.Error("nonce mismatch should fail")
	}
	// audience mismatch.
	badAud := signRS256(t, key, "test-kid", map[string]any{"iss": issuer, "aud": "other", "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, badAud, "N1"); err == nil {
		t.Error("audience mismatch should fail")
	}
	// azp can narrow a valid audience but cannot replace it.
	badAudWithAZP := signRS256(t, key, "test-kid", map[string]any{"iss": issuer, "aud": "other", "azp": "vibe-coders", "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, badAudWithAZP, "N1"); err == nil {
		t.Error("authorized party must not substitute for a missing audience")
	}
	multiAudienceWrongAZP := signRS256(t, key, "test-kid", map[string]any{"iss": issuer, "aud": []any{"vibe-coders", "other"}, "azp": "other", "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, multiAudienceWrongAZP, "N1"); err == nil {
		t.Error("multi-audience token with another authorized party should fail")
	}
	malformedAudience := signRS256(t, key, "test-kid", map[string]any{"iss": issuer, "aud": []any{"vibe-coders", 42}, "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, malformedAudience, "N1"); err == nil {
		t.Error("id_token with a non-string audience entry should fail")
	}
	// expired.
	expired := signRS256(t, key, "test-kid", map[string]any{"iss": issuer, "aud": "vibe-coders", "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(-time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, expired, "N1"); err == nil {
		t.Error("expired token should fail")
	}
	// wrong issuer.
	badIss := signRS256(t, key, "test-kid", map[string]any{"iss": "https://evil", "aud": "vibe-coders", "sub": "u", "nonce": "N1", "exp": float64(time.Now().Add(time.Hour).Unix())})
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, badIss, "N1"); err == nil {
		t.Error("issuer mismatch should fail")
	}
	// tampered signature (flip a key).
	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	forged := signRS256(t, otherKey, "test-kid", base)
	if _, err := s.verifyKeycloakIDToken(t.Context(), disc, forged, "N1"); err == nil {
		t.Error("token signed by wrong key must fail signature check")
	}
}

func TestJWKToRSARejectsMalformedKeyMaterialWithoutPanicking(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, minRSAKeyBits)
	if err != nil {
		t.Fatal(err)
	}
	modulus := base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes())
	exponent := base64.RawURLEncoding.EncodeToString([]byte{1, 0, 1})
	if parsed, err := jwkToRSA(modulus, exponent); err != nil || parsed.E != 65537 || parsed.N.Cmp(key.PublicKey.N) != 0 {
		t.Fatalf("valid JWK rejected: key=%v err=%v", parsed, err)
	}

	tests := []struct {
		name string
		n    string
		e    string
	}{
		{name: "empty modulus", n: "", e: exponent},
		{name: "undersized modulus", n: base64.RawURLEncoding.EncodeToString([]byte{1}), e: exponent},
		{name: "oversized modulus", n: base64.RawURLEncoding.EncodeToString(append([]byte{0x80}, make([]byte, maxRSAKeyBits/8)...)), e: exponent},
		{name: "empty exponent", n: modulus, e: ""},
		{name: "oversized exponent", n: modulus, e: base64.RawURLEncoding.EncodeToString(make([]byte, 9))},
		{name: "even exponent", n: modulus, e: base64.RawURLEncoding.EncodeToString([]byte{4})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := jwkToRSA(test.n, test.e); err == nil {
				t.Fatal("malformed JWK was accepted")
			}
		})
	}
}

func TestOIDCGetJSONRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"padding":"` + strings.Repeat("x", maxOIDCJSONBytes) + `"}`))
	}))
	defer server.Close()

	var result map[string]any
	if err := oidcGetJSON(t.Context(), server.URL, &result); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized OIDC response error = %v, want size rejection", err)
	}
}

func TestKeycloakJWKSCacheIsNamespacedByIssuer(t *testing.T) {
	keyA, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyB, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const (
		issuerA = "https://issuer-a.example/realms/vibe"
		issuerB = "https://issuer-b.example/realms/vibe"
		jwksA   = "https://issuer-a.example/jwks"
		jwksB   = "https://issuer-b.example/jwks"
	)
	jwksMu.Lock()
	jwksCache = map[string]jwksCacheEntry{
		issuerA + "\x00" + jwksA: {keys: map[string]*rsa.PublicKey{"shared-kid": &keyA.PublicKey}, fetched: time.Now()},
		issuerB + "\x00" + jwksB: {keys: map[string]*rsa.PublicKey{"shared-kid": &keyB.PublicKey}, fetched: time.Now()},
	}
	jwksMu.Unlock()
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{ClientID: "vibe-coders"}}}
	forged := signRS256(t, keyA, "shared-kid", map[string]any{
		"iss": issuerB, "aud": "vibe-coders", "sub": "subject", "nonce": "nonce",
		"exp": float64(time.Now().Add(time.Hour).Unix()),
	})
	if _, err := s.verifyKeycloakIDToken(t.Context(), oidcDiscovery{Issuer: issuerB, JWKSURI: jwksB}, forged, "nonce"); err == nil {
		t.Fatal("an issuer A key with the same kid must not validate an issuer B token")
	}
}

func TestVerifyKeycloakAccessToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwksMu.Lock()
	jwksCache = map[string]jwksCacheEntry{
		"https://kc.example.com/realms/vibe\x00http://unused": {keys: map[string]*rsa.PublicKey{"at-kid": &key.PublicKey}, fetched: time.Now()},
	}
	jwksMu.Unlock()
	// Seed the discovery cache so verifyKeycloakAccessToken doesn't hit the network.
	const issuer = "https://kc.example.com/realms/vibe"
	discMu.Lock()
	discCache = oidcDiscovery{Issuer: issuer, JWKSURI: "http://unused", AuthorizationEndpoint: "x", TokenEndpoint: "y"}
	discFetch = time.Now()
	discMu.Unlock()

	db := openTestStore(t)
	defer db.Close()
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{
		Enabled: true, ClientID: "vibe-coders", IssuerURL: issuer, DefaultRole: "developer",
		RoleClaim: "realm_access.roles", GroupClaim: "groups",
	}}, db: db}

	// Access token with an admin realm role → synthesized admin claims + scopes.
	tok := signRS256(t, key, "at-kid", map[string]any{
		"iss": issuer, "aud": "vibe-coders", "sub": "svc-1", "email": "svc@x.com",
		"realm_access": map[string]any{"roles": []any{"vibe-admin"}},
		"groups":       []any{"/teams/ai-platform"},
		"exp":          float64(time.Now().Add(time.Hour).Unix()),
	})
	claims, ok := s.verifyKeycloakAccessToken(t.Context(), tok)
	if !ok || claims.Role != "admin" || claims.Subject != "svc-1" || claims.TeamID != "ai-platform" {
		t.Fatalf("access token claims = %+v ok=%v", claims, ok)
	}
	if !hasScope(claims.Scopes, "admin:read") {
		t.Errorf("admin role should carry admin:read scope, got %v", claims.Scopes)
	}
	wrongAudience := signRS256(t, key, "at-kid", map[string]any{
		"iss": issuer, "aud": "other-client", "sub": "svc-1",
		"realm_access": map[string]any{"roles": []any{"vibe-admin"}},
		"exp":          float64(time.Now().Add(time.Hour).Unix()),
	})
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), wrongAudience); ok {
		t.Error("access token for another audience must be rejected")
	}
	missingSubject := signRS256(t, key, "at-kid", map[string]any{
		"iss": issuer, "aud": "vibe-coders",
		"realm_access": map[string]any{"roles": []any{"vibe-admin"}},
		"exp":          float64(time.Now().Add(time.Hour).Unix()),
	})
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), missingSubject); ok {
		t.Error("access token without a subject must be rejected")
	}
	// Expired access token rejected.
	expired := signRS256(t, key, "at-kid", map[string]any{"iss": issuer, "aud": "vibe-coders", "sub": "x", "realm_access": map[string]any{"roles": []any{"vibe-admin"}}, "exp": float64(time.Now().Add(-time.Hour).Unix())})
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), expired); ok {
		t.Error("expired access token must be rejected")
	}
	// An HS256 token (our internal format) is ignored by the Keycloak verifier.
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), "eyJhbGciOiJIUzI1NiJ9.e30.x"); ok {
		t.Error("HS256 token must not be accepted as a Keycloak access token")
	}
}

func TestProvisionKeycloakUserRequiresVerifiedEmailAndSafeLinkTarget(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{
		IssuerURL: "https://kc.example/realms/vibe", DefaultRole: "developer",
	}}, db: db}

	base := map[string]any{"sub": "subject-1", "email": "person@example.com"}
	if _, _, err := s.provisionKeycloakUser(t.Context(), base); err == nil {
		t.Fatal("an unverified email must not provision or link an account")
	}

	local := store.AuthUser{ID: "local-admin", Email: "admin@example.com", PasswordHash: "local-password-hash", Role: "super_admin", Status: "active"}
	if err := db.CreateAuthUser(t.Context(), local); err != nil {
		t.Fatal(err)
	}
	claims := map[string]any{"sub": "attacker-subject", "email": local.Email, "email_verified": true}
	if _, _, err := s.provisionKeycloakUser(t.Context(), claims); err == nil {
		t.Fatal("a verified email alone must not auto-link a local or privileged account")
	}
	if _, found, err := db.AuthIdentityBySubject(t.Context(), "keycloak", s.cfg.Keycloak.IssuerURL, "attacker-subject"); err != nil || found {
		t.Fatalf("unsafe identity link was persisted: found=%v err=%v", found, err)
	}
}

func TestProvisionKeycloakUserRevokesRemovedRoleAndTeamClaims(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{cfg: config.Config{Keycloak: config.KeycloakConfig{
		IssuerURL: "https://kc.example/realms/vibe", ClientID: "vibe-coders", DefaultRole: "developer",
		RoleClaim: "realm_access.roles", GroupClaim: "groups",
	}}, db: db}

	initial := map[string]any{
		"sub": "subject-revocation", "email": "revocation@example.com", "email_verified": true,
		"realm_access": map[string]any{"roles": []any{"vibe-admin"}},
		"groups":       []any{"/teams/privileged-team"},
	}
	user, team, err := s.provisionKeycloakUser(t.Context(), initial)
	if err != nil || user.Role != "admin" || team != "privileged-team" {
		t.Fatalf("initial provision = user=%+v team=%q err=%v", user, team, err)
	}

	removed := map[string]any{
		"sub": "subject-revocation", "email": "revocation@example.com", "email_verified": true,
		"realm_access": map[string]any{"roles": []any{}},
		"groups":       []any{},
	}
	user, team, err = s.provisionKeycloakUser(t.Context(), removed)
	if err != nil {
		t.Fatal(err)
	}
	if user.Role != "developer" || team != "" {
		t.Fatalf("revoked claims retained access: role=%q team=%q", user.Role, team)
	}
	persisted, found, err := db.AuthUserByID(t.Context(), user.ID)
	if err != nil || !found || persisted.Role != "developer" {
		t.Fatalf("persisted role = %+v found=%v err=%v", persisted, found, err)
	}
	if primaryTeam, err := db.PrimaryTeamForUser(t.Context(), user.ID); err != nil || primaryTeam != "" {
		t.Fatalf("revoked team membership = %q err=%v", primaryTeam, err)
	}
}

func TestSSOExchangeRequiresMatchingBrowserCookieAndIsSingleUse(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{cfg: config.Config{
		Auth: config.AuthConfig{Enabled: true, JWTSecret: "exchange-jwt-secret", AccessTokenTTL: 15 * time.Minute, RefreshTokenTTL: time.Hour},
	}, db: db}
	user := store.AuthUser{ID: "sso-user", Email: "sso@example.com", Role: "developer", Status: "active"}
	if err := db.CreateAuthUser(t.Context(), user); err != nil {
		t.Fatal(err)
	}
	code := "one-time-browser-code"
	if err := db.SaveOIDCLoginExchange(t.Context(), store.OIDCLoginExchange{CodeHash: hashProxyKey(code), UserID: user.ID}); err != nil {
		t.Fatal(err)
	}

	call := func(cookieValue string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/auth/sso/exchange", strings.NewReader(`{"code":"`+code+`"}`))
		req.Header.Set("Content-Type", "application/json")
		if cookieValue != "" {
			req.AddCookie(&http.Cookie{Name: ssoExchangeCookieName, Value: cookieValue})
		}
		response := httptest.NewRecorder()
		s.handleSSOExchange(response, req)
		return response
	}

	if response := call(""); response.Code != http.StatusUnauthorized {
		t.Fatalf("missing browser cookie status = %d", response.Code)
	}
	response := call(code)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "access_token") || strings.Contains(response.Body.String(), code) {
		t.Fatalf("valid exchange response = %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if response := call(code); response.Code != http.StatusUnauthorized {
		t.Fatalf("replayed exchange status = %d", response.Code)
	}
}
