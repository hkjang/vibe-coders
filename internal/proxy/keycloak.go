package proxy

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ── OIDC discovery + JWKS caches (process-wide; single issuer expected) ──────────

type oidcDiscovery struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JWKSURI               string `json:"jwks_uri"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
	EndSessionEndpoint    string `json:"end_session_endpoint"`
}

var (
	oidcHTTP = &http.Client{Timeout: 8 * time.Second}

	discMu     sync.Mutex
	discCache  oidcDiscovery
	discFetch  time.Time

	jwksMu    sync.Mutex
	jwksKeys  map[string]*rsa.PublicKey
	jwksFetch time.Time
)

const oidcCacheTTL = 10 * time.Minute

// keycloakDiscover fetches (and caches) the issuer's OIDC discovery document.
func keycloakDiscover(ctx context.Context, issuer string) (oidcDiscovery, error) {
	discMu.Lock()
	defer discMu.Unlock()
	if discCache.Issuer == issuer && time.Since(discFetch) < oidcCacheTTL {
		return discCache, nil
	}
	u := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"
	var d oidcDiscovery
	if err := oidcGetJSON(ctx, u, &d); err != nil {
		return oidcDiscovery{}, err
	}
	if d.Issuer == "" || d.AuthorizationEndpoint == "" || d.TokenEndpoint == "" || d.JWKSURI == "" {
		return oidcDiscovery{}, errors.New("incomplete OIDC discovery document")
	}
	discCache, discFetch = d, time.Now()
	return d, nil
}

// jwkSet is the subset of a JWKS document we need (RSA signing keys).
type jwkSet struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		N   string `json:"n"`
		E   string `json:"e"`
		Use string `json:"use"`
	} `json:"keys"`
}

// keycloakJWKSKey returns the RSA public key for a kid, refreshing the JWKS on a miss
// (handles key rotation) and on TTL expiry.
func keycloakJWKSKey(ctx context.Context, jwksURI, kid string) (*rsa.PublicKey, error) {
	jwksMu.Lock()
	defer jwksMu.Unlock()
	if jwksKeys != nil && time.Since(jwksFetch) < oidcCacheTTL {
		if k, ok := jwksKeys[kid]; ok {
			return k, nil
		}
	}
	// Cache miss or expired → (re)fetch.
	var set jwkSet
	if err := oidcGetJSON(ctx, jwksURI, &set); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := jwkToRSA(k.N, k.E)
		if err != nil {
			continue
		}
		keys[k.Kid] = pub
	}
	jwksKeys, jwksFetch = keys, time.Now()
	if k, ok := keys[kid]; ok {
		return k, nil
	}
	return nil, errors.New("no JWKS key for kid " + kid)
}

func jwkToRSA(nB64, eB64 string) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(nB64, "="))
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(eB64, "="))
	if err != nil {
		return nil, err
	}
	e := 0
	// Big-endian exponent bytes → int.
	padded := make([]byte, 8)
	copy(padded[8-len(eb):], eb)
	e = int(binary.BigEndian.Uint64(padded))
	if e == 0 {
		return nil, errors.New("invalid RSA exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}, nil
}

// keycloakVerifyJWT verifies an RS256 JWT's signature (via JWKS), issuer, and expiry
// (with a small clock skew), returning its claims. Shared by ID-token and access-token
// verification; ID-token-specific checks (audience, nonce) are layered on top.
func (s *Server) keycloakVerifyJWT(ctx context.Context, disc oidcDiscovery, token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed jwt")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &header) != nil {
		return nil, errors.New("bad jwt header")
	}
	if header.Alg != "RS256" {
		return nil, errors.New("unsupported jwt alg: " + header.Alg)
	}
	key, err := keycloakJWKSKey(ctx, disc.JWKSURI, header.Kid)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("bad jwt signature encoding")
	}
	signed := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, signed[:], sig); err != nil {
		return nil, errors.New("jwt signature verification failed")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("bad jwt payload")
	}
	var claims map[string]any
	if err := json.Unmarshal(pb, &claims); err != nil {
		return nil, errors.New("bad jwt claims")
	}
	if iss, _ := claims["iss"].(string); iss != disc.Issuer {
		return nil, errors.New("jwt issuer mismatch")
	}
	if exp, ok := claims["exp"].(float64); ok {
		if time.Now().Add(-60 * time.Second).After(time.Unix(int64(exp), 0)) {
			return nil, errors.New("jwt expired")
		}
	} else {
		return nil, errors.New("jwt missing exp")
	}
	return claims, nil
}

// verifyKeycloakIDToken verifies an RS256 ID token (signature/issuer/expiry) plus audience
// and nonce, returning its claims.
func (s *Server) verifyKeycloakIDToken(ctx context.Context, disc oidcDiscovery, idToken, expectedNonce string) (map[string]any, error) {
	claims, err := s.keycloakVerifyJWT(ctx, disc, idToken)
	if err != nil {
		return nil, err
	}
	if !audienceMatches(claims["aud"], s.keycloakConfig().ClientID) {
		if azp, _ := claims["azp"].(string); azp != s.keycloakConfig().ClientID {
			return nil, errors.New("id_token audience mismatch")
		}
	}
	if expectedNonce != "" {
		if n, _ := claims["nonce"].(string); n != expectedNonce {
			return nil, errors.New("id_token nonce mismatch")
		}
	}
	return claims, nil
}

// verifyKeycloakAccessToken verifies a Keycloak-issued RS256 access token (signature, issuer,
// expiry) and synthesizes internal accessClaims (role/scopes from role mapping). Lets machine
// clients and SSO callers authenticate to the API/admin with a Keycloak bearer token. No
// internal session is required (the token is externally minted).
func (s *Server) verifyKeycloakAccessToken(ctx context.Context, token string) (accessClaims, bool) {
	if !s.keycloakConfig().Enabled || token == "" {
		return accessClaims{}, false
	}
	// Cheap reject: our internal tokens are HS256; only attempt RS256 ones.
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return accessClaims{}, false
	}
	if hb, err := base64.RawURLEncoding.DecodeString(parts[0]); err == nil {
		var h struct{ Alg string `json:"alg"` }
		if json.Unmarshal(hb, &h) == nil && h.Alg != "RS256" {
			return accessClaims{}, false
		}
	}
	disc, err := keycloakDiscover(ctx, s.keycloakConfig().IssuerURL)
	if err != nil {
		return accessClaims{}, false
	}
	claims, err := s.keycloakVerifyJWT(ctx, disc, token)
	if err != nil {
		return accessClaims{}, false
	}
	role := resolveKeycloakRoleWith(s.effectiveKeycloakRoleMap(), s.keycloakRolesFromClaims(claims), s.keycloakConfig().DefaultRole)
	if role == "" {
		return accessClaims{}, false
	}
	exp := int64(0)
	if v, ok := claims["exp"].(float64); ok {
		exp = int64(v)
	}
	return accessClaims{
		Subject:   strClaim(claims, "sub"),
		Email:     strClaim(claims, "email"),
		Role:      role,
		TeamID:    keycloakTeamFromGroups(claimStrings(claims, s.keycloakConfig().GroupClaim)),
		Scopes:    s.effectiveScopesForRole(ctx, role),
		ExpiresAt: exp,
		Type:      "access",
	}, true
}

func audienceMatches(aud any, clientID string) bool {
	switch v := aud.(type) {
	case string:
		return v == clientID
	case []any:
		for _, a := range v {
			if s, _ := a.(string); s == clientID {
				return true
			}
		}
	}
	return false
}

func oidcGetJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := oidcHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ── login-flow state store (state → nonce + PKCE verifier), short-lived ──────────

type oidcFlowState struct {
	nonce    string
	verifier string
	created  time.Time
}

var (
	flowMu    sync.Mutex
	flowState = map[string]oidcFlowState{}
)

func storeFlowState(state string, fs oidcFlowState) {
	flowMu.Lock()
	defer flowMu.Unlock()
	// Prune expired (>10m) entries opportunistically.
	for k, v := range flowState {
		if time.Since(v.created) > 10*time.Minute {
			delete(flowState, k)
		}
	}
	flowState[state] = fs
}

func takeFlowState(state string) (oidcFlowState, bool) {
	flowMu.Lock()
	defer flowMu.Unlock()
	fs, ok := flowState[state]
	if ok {
		delete(flowState, state)
	}
	if ok && time.Since(fs.created) > 10*time.Minute {
		return oidcFlowState{}, false
	}
	return fs, ok
}

// saveOIDCFlow persists the login-flow state in the DB (durable across restarts and shared across
// instances) and mirrors it in the in-memory map as a fallback for the single-instance/no-DB case.
func (s *Server) saveOIDCFlow(ctx context.Context, state, nonce, verifier string) {
	now := time.Now()
	storeFlowState(state, oidcFlowState{nonce: nonce, verifier: verifier, created: now})
	if s.db != nil {
		if err := s.db.SaveOIDCFlowState(ctx, state, nonce, verifier, now.UTC()); err != nil {
			slog.Warn("persist oidc flow state failed; relying on in-memory state", "error", err)
		}
	}
}

// takeOIDCFlow consumes the login-flow state, preferring the durable DB copy and falling back to
// the in-memory map (so a callback that lands on the originating instance still works if the DB
// write had failed).
func (s *Server) takeOIDCFlow(ctx context.Context, state string) (oidcFlowState, bool) {
	if s.db != nil {
		if nonce, verifier, found, err := s.db.TakeOIDCFlowState(ctx, state); err != nil {
			slog.Warn("read oidc flow state failed; falling back to in-memory", "error", err)
		} else if found {
			_, _ = takeFlowState(state) // clear any mirrored in-memory copy
			return oidcFlowState{nonce: nonce, verifier: verifier, created: time.Now()}, true
		}
	}
	return takeFlowState(state)
}

func randomURLSafe(nbytes int) string {
	b := make([]byte, nbytes)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// ── role/group mapping ───────────────────────────────────────────────────────

// keycloakRoleMap maps Keycloak realm/client roles to internal roles (highest rank wins).
var keycloakRoleMap = map[string]string{
	"vibe-admin":      "admin",
	"vibe-team-admin": "team_admin",
	"vibe-developer":  "developer",
	"vibe-auditor":    "readonly_admin",
}

// resolveKeycloakRole picks the highest-privilege internal role among the user's mapped roles
// using the built-in default map, falling back to defaultRole ("" = block login).
func resolveKeycloakRole(roles []string, defaultRole string) string {
	return resolveKeycloakRoleWith(keycloakRoleMap, roles, defaultRole)
}

// resolveKeycloakRoleWith is resolveKeycloakRole with an explicit (possibly admin-edited) map.
func resolveKeycloakRoleWith(roleMap map[string]string, roles []string, defaultRole string) string {
	role, _ := resolveKeycloakRoleExplicit(roleMap, roles, defaultRole)
	return role
}

// resolveKeycloakRoleExplicit resolves the internal role and reports whether it came from an
// explicit claim→role mapping (true) or the default fallback (false). A fallback role must not
// silently overwrite an existing user's internal role — otherwise a super_admin whose IdP carries
// no mapped role would be demoted to the default role on their next SSO login.
func resolveKeycloakRoleExplicit(roleMap map[string]string, roles []string, defaultRole string) (string, bool) {
	if len(roleMap) == 0 {
		roleMap = keycloakRoleMap
	}
	best := ""
	bestRank := -1
	for _, r := range roles {
		if internal, ok := roleMap[strings.TrimSpace(r)]; ok {
			if rank := roleRank(internal); rank > bestRank {
				bestRank = rank
				best = internal
			}
		}
	}
	if best != "" {
		return best, true
	}
	return strings.TrimSpace(defaultRole), false
}

// keycloakTeamFromGroups extracts a team id from a "/teams/<name>[/...]" group path.
func keycloakTeamFromGroups(groups []string) string {
	for _, g := range groups {
		g = strings.Trim(g, "/")
		parts := strings.Split(g, "/")
		if len(parts) >= 2 && parts[0] == "teams" {
			return parts[1]
		}
	}
	return ""
}

// claimStrings extracts a []string from a dotted claim path (e.g. realm_access.roles).
func claimStrings(claims map[string]any, path string) []string {
	cur := any(claims)
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[seg]
	}
	return toStringSlice(cur)
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, _ := e.(string); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// keycloakRolesFromClaims gathers realm roles (configured RoleClaim path) + client roles
// (resource_access.<clientID>.roles).
func (s *Server) keycloakRolesFromClaims(claims map[string]any) []string {
	roles := claimStrings(claims, s.keycloakConfig().RoleClaim)
	if ra, ok := claims["resource_access"].(map[string]any); ok {
		if c, ok := ra[s.keycloakConfig().ClientID].(map[string]any); ok {
			roles = append(roles, toStringSlice(c["roles"])...)
		}
	}
	return roles
}
