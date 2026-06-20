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

// verifyKeycloakIDToken verifies an RS256 ID token's signature (via JWKS), issuer, audience,
// expiry, and nonce, returning its claims.
func (s *Server) verifyKeycloakIDToken(ctx context.Context, disc oidcDiscovery, idToken, expectedNonce string) (map[string]any, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed id_token")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &header) != nil {
		return nil, errors.New("bad id_token header")
	}
	if header.Alg != "RS256" {
		return nil, errors.New("unsupported id_token alg: " + header.Alg)
	}
	key, err := keycloakJWKSKey(ctx, disc.JWKSURI, header.Kid)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("bad id_token signature encoding")
	}
	signed := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, signed[:], sig); err != nil {
		return nil, errors.New("id_token signature verification failed")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("bad id_token payload")
	}
	var claims map[string]any
	if err := json.Unmarshal(pb, &claims); err != nil {
		return nil, errors.New("bad id_token claims")
	}
	// issuer (fixed against the configured/discovered issuer).
	if iss, _ := claims["iss"].(string); iss != disc.Issuer {
		return nil, errors.New("id_token issuer mismatch")
	}
	// audience.
	if !audienceMatches(claims["aud"], s.cfg.Keycloak.ClientID) {
		if azp, _ := claims["azp"].(string); azp != s.cfg.Keycloak.ClientID {
			return nil, errors.New("id_token audience mismatch")
		}
	}
	// expiry (with small clock skew).
	if exp, ok := claims["exp"].(float64); ok {
		if time.Now().Add(-60 * time.Second).After(time.Unix(int64(exp), 0)) {
			return nil, errors.New("id_token expired")
		}
	} else {
		return nil, errors.New("id_token missing exp")
	}
	// nonce (replay protection).
	if expectedNonce != "" {
		if n, _ := claims["nonce"].(string); n != expectedNonce {
			return nil, errors.New("id_token nonce mismatch")
		}
	}
	return claims, nil
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

// resolveKeycloakRole picks the highest-privilege internal role among the user's mapped
// roles, falling back to defaultRole ("" = block login).
func resolveKeycloakRole(roles []string, defaultRole string) string {
	best := ""
	bestRank := -1
	for _, r := range roles {
		if internal, ok := keycloakRoleMap[strings.TrimSpace(r)]; ok {
			if rank := roleRank(internal); rank > bestRank {
				bestRank = rank
				best = internal
			}
		}
	}
	if best != "" {
		return best
	}
	return strings.TrimSpace(defaultRole)
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
	roles := claimStrings(claims, s.cfg.Keycloak.RoleClaim)
	if ra, ok := claims["resource_access"].(map[string]any); ok {
		if c, ok := ra[s.cfg.Keycloak.ClientID].(map[string]any); ok {
			roles = append(roles, toStringSlice(c["roles"])...)
		}
	}
	return roles
}
