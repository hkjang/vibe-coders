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
	"io"
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

	discMu    sync.Mutex
	discCache oidcDiscovery
	discFetch time.Time

	jwksMu    sync.Mutex
	jwksCache = map[string]jwksCacheEntry{}
)

type jwksCacheEntry struct {
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

const (
	oidcCacheTTL     = 10 * time.Minute
	maxOIDCJSONBytes = 1 << 20 // discovery and JWKS documents are configuration, never bulk data
	minRSAKeyBits    = 2048
	maxRSAKeyBits    = 8192
)

func invalidateOIDCCaches() {
	discMu.Lock()
	discCache = oidcDiscovery{}
	discFetch = time.Time{}
	discMu.Unlock()
	jwksMu.Lock()
	jwksCache = map[string]jwksCacheEntry{}
	jwksMu.Unlock()
}

// keycloakDiscover fetches (and caches) the issuer's OIDC discovery document.
func keycloakDiscover(ctx context.Context, issuer string) (oidcDiscovery, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
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
	if d.Issuer != issuer {
		return oidcDiscovery{}, fmt.Errorf("OIDC discovery issuer mismatch: got %q", d.Issuer)
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
func keycloakJWKSKey(ctx context.Context, issuer, jwksURI, kid string) (*rsa.PublicKey, error) {
	jwksMu.Lock()
	defer jwksMu.Unlock()
	cacheKey := issuer + "\x00" + jwksURI
	if cached, ok := jwksCache[cacheKey]; ok && time.Since(cached.fetched) < oidcCacheTTL {
		if k, ok := cached.keys[kid]; ok {
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
	jwksCache[cacheKey] = jwksCacheEntry{keys: keys, fetched: time.Now()}
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
	modulus := new(big.Int).SetBytes(nb)
	if bits := modulus.BitLen(); bits < minRSAKeyBits || bits > maxRSAKeyBits {
		return nil, fmt.Errorf("invalid RSA modulus size: %d bits", bits)
	}
	eb, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(eB64, "="))
	if err != nil {
		return nil, err
	}
	if len(eb) == 0 || len(eb) > 8 {
		return nil, errors.New("invalid RSA exponent size")
	}
	// Big-endian exponent bytes → int.
	padded := make([]byte, 8)
	copy(padded[8-len(eb):], eb)
	exponent := binary.BigEndian.Uint64(padded)
	if exponent > uint64(^uint(0)>>1) {
		return nil, errors.New("RSA exponent overflows int")
	}
	e := int(exponent)
	if e < 3 || e%2 == 0 {
		return nil, errors.New("invalid RSA exponent")
	}
	return &rsa.PublicKey{N: modulus, E: e}, nil
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
	key, err := keycloakJWKSKey(ctx, disc.Issuer, disc.JWKSURI, header.Kid)
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
	clientID := s.keycloakConfig().ClientID
	if !audienceMatches(claims["aud"], clientID) {
		return nil, errors.New("id_token audience mismatch")
	}
	// azp identifies the authorized party; it narrows a valid audience and can never
	// substitute for a missing audience grant. Require it for multi-audience ID tokens
	// and reject an explicit value for a different client.
	azp, azpPresent := claims["azp"]
	azpValue, azpIsString := azp.(string)
	if (audienceCount(claims["aud"]) > 1 && (!azpIsString || azpValue != clientID)) ||
		(azpPresent && (!azpIsString || azpValue != clientID)) {
		return nil, errors.New("id_token authorized party mismatch")
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
	kc := s.keycloakConfig()
	if !kc.Enabled || kc.ClientID == "" || token == "" {
		return accessClaims{}, false
	}
	// Cheap reject: our internal tokens are HS256; only attempt RS256 ones.
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return accessClaims{}, false
	}
	if hb, err := base64.RawURLEncoding.DecodeString(parts[0]); err == nil {
		var h struct {
			Alg string `json:"alg"`
		}
		if json.Unmarshal(hb, &h) == nil && h.Alg != "RS256" {
			return accessClaims{}, false
		}
	}
	disc, err := keycloakDiscover(ctx, kc.IssuerURL)
	if err != nil {
		return accessClaims{}, false
	}
	claims, err := s.keycloakVerifyJWT(ctx, disc, token)
	if err != nil {
		return accessClaims{}, false
	}
	// An access token minted for another client in the same realm has a valid issuer
	// and signature too. This service is a resource server, so its configured client
	// ID must be an explicit audience; azp alone is not an audience grant.
	if !audienceMatches(claims["aud"], kc.ClientID) || strClaim(claims, "sub") == "" {
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
	values, valid := audienceValues(aud)
	if !valid {
		return false
	}
	for _, value := range values {
		if value == clientID {
			return true
		}
	}
	return false
}

func audienceCount(aud any) int {
	values, valid := audienceValues(aud)
	if !valid {
		return 0
	}
	return len(values)
}

// audienceValues enforces JWT StringOrURI semantics. Ignoring malformed array entries can
// accidentally turn a multi-audience token into a single-audience token and skip the azp check.
func audienceValues(aud any) ([]string, bool) {
	switch value := aud.(type) {
	case string:
		if value == "" {
			return nil, false
		}
		return []string{value}, true
	case []any:
		if len(value) == 0 {
			return nil, false
		}
		values := make([]string, 0, len(value))
		for _, item := range value {
			text, ok := item.(string)
			if !ok || text == "" {
				return nil, false
			}
			values = append(values, text)
		}
		return values, true
	default:
		return nil, false
	}
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxOIDCJSONBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxOIDCJSONBytes {
		return fmt.Errorf("GET %s: OIDC JSON exceeds %d bytes", url, maxOIDCJSONBytes)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("GET %s: decode OIDC JSON: %w", url, err)
	}
	return nil
}

// ── login-flow state store (state → nonce + PKCE verifier), short-lived ──────────

type oidcFlowState struct {
	nonce    string
	verifier string
	returnTo string
	created  time.Time
	// persisted distinguishes a durable DB mirror from the only copy retained after a failed
	// DB save. A normal DB miss must never resurrect a durable flow already consumed by a pod.
	persisted bool
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
func (s *Server) saveOIDCFlow(ctx context.Context, state, nonce, verifier, returnTo string) {
	now := time.Now()
	fs := oidcFlowState{nonce: nonce, verifier: verifier, returnTo: returnTo, created: now}
	if s.db != nil {
		if err := s.db.SaveOIDCFlowState(ctx, state, nonce, verifier, returnTo, now.UTC()); err != nil {
			slog.Warn("persist oidc flow state failed; relying on in-memory state", "error", err)
		} else {
			fs.persisted = true
		}
	}
	storeFlowState(state, fs)
}

// takeOIDCFlow consumes the login-flow state, preferring the durable DB copy and falling back to
// the in-memory map (so a callback that lands on the originating instance still works if the DB
// write had failed).
func (s *Server) takeOIDCFlow(ctx context.Context, state string) (oidcFlowState, bool) {
	if s.db != nil {
		if nonce, verifier, returnTo, found, err := s.db.TakeOIDCFlowState(ctx, state); err != nil {
			slog.Warn("read oidc flow state failed", "error", err)
			// Fail closed for a state that was successfully persisted: another pod might have
			// consumed it before this read failed. Only a state whose DB save failed is safe to
			// recover from the originating process's memory.
			fs, ok := takeFlowState(state)
			if !ok || fs.persisted {
				return oidcFlowState{}, false
			}
			return fs, true
		} else if found {
			_, _ = takeFlowState(state) // clear any mirrored in-memory copy
			return oidcFlowState{nonce: nonce, verifier: verifier, returnTo: returnTo, created: time.Now()}, true
		} else {
			// A healthy DB miss means another pod already consumed (or pruned) any durable row.
			// Remove its mirror without returning it. Only a failed DB save has no durable copy
			// and may therefore use the originating pod's in-memory state.
			fs, ok := takeFlowState(state)
			if !ok || fs.persisted {
				return oidcFlowState{}, false
			}
			return fs, true
		}
	}
	return takeFlowState(state)
}

func randomURLSafe(nbytes int) (string, error) {
	b := make([]byte, nbytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
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
// explicit claim→role mapping (true) or the configured default fallback (false). Both outcomes
// are authoritative for SSO-linked users so removed IdP roles cannot leave stale privileges.
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
