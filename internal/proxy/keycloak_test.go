package proxy

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestResolveKeycloakRole(t *testing.T) {
	cases := []struct {
		roles   []string
		def     string
		want    string
	}{
		{[]string{"vibe-developer"}, "developer", "developer"},
		{[]string{"vibe-admin", "vibe-developer"}, "developer", "admin"},   // highest rank wins
		{[]string{"vibe-team-admin", "vibe-auditor"}, "developer", "team_admin"},
		{[]string{"unknown-role"}, "developer", "developer"},               // fallback default
		{[]string{"unknown-role"}, "", ""},                                 // no default → block
		{[]string{"vibe-auditor"}, "developer", "readonly_admin"},
	}
	for i, c := range cases {
		if got := resolveKeycloakRole(c.roles, c.def); got != c.want {
			t.Errorf("case %d: resolveKeycloakRole(%v, %q) = %q, want %q", i, c.roles, c.def, got, c.want)
		}
	}
}

// resolveKeycloakRoleExplicit must distinguish an explicit claim→role match from a default
// fallback, so SSO login never silently demotes an existing user (e.g. super_admin) whose IdP
// carries no mapped role.
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
	jwksKeys = map[string]*rsa.PublicKey{"test-kid": &key.PublicKey}
	jwksFetch = time.Now()
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

func TestVerifyKeycloakAccessToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwksMu.Lock()
	jwksKeys = map[string]*rsa.PublicKey{"at-kid": &key.PublicKey}
	jwksFetch = time.Now()
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
		"iss": issuer, "sub": "svc-1", "email": "svc@x.com",
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
	// Expired access token rejected.
	expired := signRS256(t, key, "at-kid", map[string]any{"iss": issuer, "sub": "x", "realm_access": map[string]any{"roles": []any{"vibe-admin"}}, "exp": float64(time.Now().Add(-time.Hour).Unix())})
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), expired); ok {
		t.Error("expired access token must be rejected")
	}
	// An HS256 token (our internal format) is ignored by the Keycloak verifier.
	if _, ok := s.verifyKeycloakAccessToken(t.Context(), "eyJhbGciOiJIUzI1NiJ9.e30.x"); ok {
		t.Error("HS256 token must not be accepted as a Keycloak access token")
	}
}
