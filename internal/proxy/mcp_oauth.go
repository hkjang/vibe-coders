package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// MCP 를 SSO 로 — 개인 키 없이, Keycloak 이 발급한 액세스 토큰으로.
//
// The MCP authorization specification (2025-06-18 and later) is OAuth 2.1: the
// MCP server is a *resource server* that publishes where its authorization
// server is (RFC 9728, /.well-known/oauth-protected-resource), and a client
// refused with 401 reads that document, sends the person through Keycloak with
// PKCE, and comes back with an access token whose audience (RFC 8707) is this
// gateway. Nothing about issuing tokens happens here — Keycloak does that — so
// this file answers two questions only: where is the authorization server, and
// is this token one it issued for us.
//
// The personal key stays. It is what an automation with no person behind it
// uses, and what a deployment without Keycloak uses. A token from SSO is a
// second door into the same room: it authenticates an *existing* account that
// already signed in to the web once, carries the scopes the administrator
// chose (never wider than the account's role), and is accepted on the MCP
// endpoints only. It never creates an account, never revives a disabled one,
// and never reads a role out of the token.

const (
	mcpOAuthEnabledKey  = "mcp.oauth.enabled"
	mcpOAuthResourceKey = "mcp.oauth.resource"
	mcpOAuthAudienceKey = "mcp.oauth.audience"
	mcpOAuthScopesKey   = "mcp.oauth.scopes"

	// mcpOAuthDefaultScopes is what an SSO subject may do unless the
	// administrator says otherwise: the scope the /mcp key check already asks for.
	mcpOAuthDefaultScopes = "mcp:use"

	// protectedResourceMetadataPath is RFC 9728's well-known location. The path
	// suffix names the resource (…/mcp, …/mcp/gateway); the bare path describes
	// the aggregating /mcp endpoint.
	protectedResourceMetadataPath = "/.well-known/oauth-protected-resource"

	// mcpOAuthClockSkew tolerates small clock differences with Keycloak for nbf,
	// matching the leeway keycloakVerifyJWT already grants exp.
	mcpOAuthClockSkew = 60 * time.Second
)

// mcpOAuthConfig is the administrator's part of the picture. The issuer and the
// web sign-in's client id are reused from the Keycloak configuration rather
// than asked for again.
type mcpOAuthConfig struct {
	Enabled bool
	// Resource is the identifier this gateway claims for /mcp (RFC 8707). Empty
	// means it is derived from the Keycloak redirect URI's origin — the one
	// public address this deployment already had to write down. Never from the
	// request: Host and X-Forwarded-* are the caller's to choose, and an
	// identifier built from them is an audience the caller picks.
	Resource string
	// Audience lists additional accepted aud/azp values. A real Keycloak 26 puts
	// only "account" in aud and the client id in azp, so naming the MCP client
	// here is the path that needs no mapper.
	Audience []string
	// Scopes is the ceiling for an SSO subject. A token does not carry this
	// gateway's scope vocabulary unless somebody teaches Keycloak the vocabulary,
	// and asking every deployment to do so before MCP works is the wrong trade.
	Scopes []string
}

func mcpOAuthSettingDefs() []settingDef {
	constant := func(value string) func(config.Config) string {
		return func(config.Config) string { return value }
	}
	optionalHTTPSURL := func(value string) error {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("must be an http(s) URL without query or fragment, such as https://gateway.example/mcp")
		}
		return nil
	}
	knownScopes := func(value string) error {
		for _, scope := range strings.Fields(value) {
			if !hasScope(allScopes, scope) {
				return fmt.Errorf("unknown scope %q (known: %s)", scope, strings.Join(allScopes, " "))
			}
		}
		return nil
	}
	return []settingDef{
		{Key: mcpOAuthEnabledKey, Category: "mcp", Type: stBool, envValue: constant("false")},
		{Key: mcpOAuthResourceKey, Category: "mcp", Type: stString, validate: optionalHTTPSURL, envValue: constant("")},
		{Key: mcpOAuthAudienceKey, Category: "mcp", Type: stString, envValue: constant("")},
		{Key: mcpOAuthScopesKey, Category: "mcp", Type: stString, validate: knownScopes, envValue: constant(mcpOAuthDefaultScopes)},
	}
}

func init() {
	settingDescriptions[mcpOAuthEnabledKey] = "MCP(/mcp, /mcp/gateway)에 Keycloak SSO 액세스 토큰으로 접속 허용. 기본 꺼짐. 개인 키는 그대로 동작하며, SSO 설정(발급자)이 켜져 있어야 실제로 켜집니다."
	settingDescriptions[mcpOAuthResourceKey] = "이 게이트웨이의 MCP 리소스 식별자(공개 주소 + /mcp, 예: https://gateway.example/mcp). 비우면 Keycloak Redirect URI 의 출처로 만들고, 그것도 없으면 SSO 토큰을 받지 않습니다(요청 Host 로는 만들지 않습니다)."
	settingDescriptions[mcpOAuthAudienceKey] = "허용 대상(공백 구분). 토큰의 aud 또는 azp 가 이 목록에 있으면 통과 — Keycloak 의 MCP 클라이언트 ID 를 적으면 Audience 매퍼 없이 동작합니다."
	settingDescriptions[mcpOAuthScopesKey] = "SSO 토큰 주체에게 주는 범위(공백 구분, 기본 mcp:use). 계정 역할의 범위와 교집합만 적용됩니다."
}

// mcpOAuthConf returns the runtime snapshot; off until the first settings reload.
func (s *Server) mcpOAuthConf() mcpOAuthConfig {
	if value := s.mcpOAuthRuntime.Load(); value != nil {
		return *value
	}
	return mcpOAuthConfig{Scopes: strings.Fields(mcpOAuthDefaultScopes)}
}

func (s *Server) reloadMCPOAuthRuntime(stored map[string]store.AdminSetting) {
	get := func(key string) string {
		def, ok := settingDefByKey(key)
		if !ok {
			return ""
		}
		value, _, _ := s.effectiveSettingValue(stored, def)
		return strings.TrimSpace(value)
	}
	enabled, _ := strconv.ParseBool(get(mcpOAuthEnabledKey))
	conf := mcpOAuthConfig{
		Enabled:  enabled,
		Resource: strings.TrimRight(get(mcpOAuthResourceKey), "/"),
		Audience: strings.Fields(get(mcpOAuthAudienceKey)),
		Scopes:   strings.Fields(get(mcpOAuthScopesKey)),
	}
	s.mcpOAuthRuntime.Store(&conf)
}

// mcpOAuthState is the effective picture for one request: configuration plus
// what the Keycloak settings contribute, and the reason it is inactive if it is.
type mcpOAuthState struct {
	conf     mcpOAuthConfig
	Issuer   string
	ClientID string
	// Resource is the identifier for /mcp; other MCP paths derive from its origin.
	Resource string
	// Reason is empty when SSO tokens are accepted, otherwise why not.
	Reason string
}

func (st mcpOAuthState) Active() bool { return st.Reason == "" }

// base is the public origin the resource identifier was built on.
func (st mcpOAuthState) base() string { return strings.TrimSuffix(st.Resource, "/mcp") }

// resourceFor is the identifier of the MCP endpoint at path (/mcp or /mcp/gateway).
func (st mcpOAuthState) resourceFor(path string) string { return st.base() + path }

// metadataURL is where a refused client is sent to learn the above.
func (st mcpOAuthState) metadataURL(path string) string {
	return st.base() + protectedResourceMetadataPath + path
}

// mcpOAuthState computes the effective state. The switch alone does not open the
// door: the issuer has to exist (Keycloak SSO configured and on) and a resource
// identifier has to be derivable from configuration, otherwise it stays closed
// and the status endpoint says why. Nothing here is read from a request — the
// resource identifier is the audience a token is checked against, so it cannot
// be something the caller supplies (Host, X-Forwarded-Host, X-Forwarded-Proto).
// SSO_KEYCLOAK_REDIRECT_URI is not validated on the environment path, so the
// "neither is set" case is reachable, and it is a closed door, not a fallback.
func (s *Server) mcpOAuthState() mcpOAuthState {
	conf := s.mcpOAuthConf()
	kc := s.keycloakConfig()
	st := mcpOAuthState{conf: conf, Issuer: strings.TrimRight(strings.TrimSpace(kc.IssuerURL), "/"), ClientID: strings.TrimSpace(kc.ClientID)}
	st.Resource = conf.Resource
	if st.Resource == "" {
		if origin := originOf(kc.RedirectURI); origin != "" {
			st.Resource = origin + "/mcp"
		}
	}
	switch {
	case !conf.Enabled:
		st.Reason = mcpOAuthEnabledKey + " 가 꺼져 있습니다."
	case !s.cfg.Auth.Enabled:
		st.Reason = "계정 인증(AUTH_ENABLED)이 꺼져 있어 SSO 계정을 찾을 수 없습니다."
	case !kc.Enabled || st.Issuer == "":
		st.Reason = "Keycloak SSO 가 꺼져 있거나 발급자 주소(issuer)가 비어 있습니다. SSO 설정을 먼저 완성하세요."
	case st.Resource == "":
		st.Reason = mcpOAuthResourceKey + " 가 비어 있고 Keycloak Redirect URI 로도 공개 주소를 알 수 없습니다. 요청 Host 로는 만들지 않으므로 " + mcpOAuthResourceKey + " 에 공개 주소 + /mcp 를 적으세요."
	}
	return st
}

// originOf returns scheme://host of an absolute http(s) URL, or "".
func originOf(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

// isMCPPath reports whether a request is for one of the MCP endpoints — the only
// places an SSO token is accepted and the only 401s that carry the challenge.
func isMCPPath(path string) bool {
	return path == "/mcp" || path == "/mcp/gateway"
}

// looksLikeJWT is the cheap shape test that separates a key from a token. Keys
// issued here are a prefix plus base64url and can never contain a dot, so a
// three-part dotted string is never a key whatever prefix a deployment chose.
func looksLikeJWT(token string) bool {
	parts := strings.Split(token, ".")
	return len(parts) == 3 && parts[0] != "" && parts[1] != "" && parts[2] != ""
}

// mcpOAuthRefusal says exactly why a token was not accepted. The message is
// meant for the operator reading the client's error: it names what the token
// carried and what to change. Cause is the underlying finding in the server's
// own words (which check failed, what the token carried) and goes to the
// server log, so the operator can tell a bad signature from a wrong issuer
// even when the client only relays "invalid_token".
type mcpOAuthRefusal struct {
	Code    string
	Message string
	Cause   string
}

func (e *mcpOAuthRefusal) Error() string { return e.Code + ": " + e.Message }

// mcpPrincipal is an SSO subject an MCP handler has already authenticated. The
// gateway tools that run a completion (gateway_chat, gateway_run_skill, …)
// re-enter /v1/chat/completions in-process with the caller's bearer, and that
// door must keep refusing SSO tokens — so the principal travels by context, a
// channel no external request can set. Keys are not carried this way: their
// re-entry re-authenticates the key exactly as before.
type mcpPrincipal struct {
	ID      string
	AuthCtx *store.AuthContext
}

type mcpPrincipalKey struct{}

func withMCPPrincipal(ctx context.Context, id string, authCtx *store.AuthContext) context.Context {
	return context.WithValue(ctx, mcpPrincipalKey{}, &mcpPrincipal{ID: id, AuthCtx: authCtx})
}

func mcpPrincipalFrom(ctx context.Context) *mcpPrincipal {
	p, _ := ctx.Value(mcpPrincipalKey{}).(*mcpPrincipal)
	return p
}

// ssoPrincipalID is the identity the MCP call log and route decisions record for
// an SSO subject; it is never an api_keys id. isSSOPrincipalID is the one place
// that reads the shape back.
func ssoPrincipalID(userID string) string { return "sso_" + userID }
func isSSOPrincipalID(id string) bool     { return strings.HasPrefix(id, "sso_") }

// mcpRequestWithPrincipal attaches an SSO principal for the in-process re-entry
// described at mcpPrincipal; a key principal leaves the request untouched.
func mcpRequestWithPrincipal(r *http.Request, id string, authCtx *store.AuthContext) *http.Request {
	if authCtx == nil || !isSSOPrincipalID(id) {
		return r
	}
	return r.WithContext(withMCPPrincipal(r.Context(), id, authCtx))
}

// authorizeMCPPrincipalReentry is what authenticateProxyContextWithOutcome does
// for a request carrying an SSO principal: the same scope gate a key passes for
// that path, against the scopes the administrator granted the SSO subject.
func (s *Server) authorizeMCPPrincipalReentry(r *http.Request, p *mcpPrincipal) (string, *store.AuthContext, authOutcome) {
	if scope := apiScopeForRequest(r); s.cfg.Auth.Enabled && scope != "" && !hasScope(p.AuthCtx.Scopes, scope) {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "scope_denied", ActorUserID: p.AuthCtx.UserID, TeamID: p.AuthCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "mcp oauth: " + scope, CreatedAt: time.Now().UTC()})
		slog.Warn("mcp oauth subject lacks scope for in-process call", "user_id", p.AuthCtx.UserID, "path", r.URL.Path, "scope", scope, "granted", p.AuthCtx.Scopes)
		return "", nil, authDenied
	}
	return p.ID, p.AuthCtx, authOK
}

// authenticateMCP is authenticateProxyContext for the MCP endpoints: the same
// bearer header, two kinds of credential. A JWT-shaped bearer goes to the SSO
// check while that door is open; everything else — every key, and every JWT
// while SSO tokens are off — takes exactly the path it took before, so a
// deployment that never enabled this sees nothing new. The refusal is non-nil
// only when an SSO token was examined and turned away.
func (s *Server) authenticateMCP(r *http.Request) (string, *store.AuthContext, authOutcome, *mcpOAuthRefusal) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token != "" && looksLikeJWT(token) {
		if st := s.mcpOAuthState(); st.Active() {
			// A credential the key table knows is a key, whatever it looks like.
			if _, found, err := s.db.FindActiveAPIKeyByHash(r.Context(), hashProxyKey(token)); err != nil {
				return "", nil, authUnavailable, nil
			} else if found {
				id, authCtx, outcome := s.authenticateProxyContextWithOutcome(r)
				return id, authCtx, outcome, nil
			}
			id, authCtx, err := s.mcpOAuthPrincipal(r, st, token)
			if err != nil {
				var refusal *mcpOAuthRefusal
				if rf, ok := err.(*mcpOAuthRefusal); ok {
					refusal = rf
				} else {
					return "", nil, authUnavailable, nil
				}
				// The client sees the message; the operator's log gets the cause —
				// which check failed and what the token carried — because a client
				// often relays nothing more than "invalid_token". request_id is the
				// X-Request-ID the response carries (withTrace pinned it on the
				// request), so the client's failed call and this line can be matched.
				slog.Warn("mcp oauth token refused", "request_id", traceIDFromRequest(r), "code", refusal.Code, "cause", firstNonEmpty(refusal.Cause, refusal.Message), "path", r.URL.Path, "ip", clientIP(r))
				_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "api_key_denied", IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "mcp oauth: " + refusal.Code, CreatedAt: time.Now().UTC()})
				return "", nil, authDenied, refusal
			}
			return id, authCtx, authOK, nil
		}
	}
	id, authCtx, outcome := s.authenticateProxyContextWithOutcome(r)
	return id, authCtx, outcome, nil
}

// mcpOAuthPrincipal turns a bearer access token into the auth context the MCP
// handlers run under, or says exactly why it will not. A *mcpOAuthRefusal is a
// verdict about the token; any other error means the store could not be asked.
func (s *Server) mcpOAuthPrincipal(r *http.Request, st mcpOAuthState, token string) (string, *store.AuthContext, error) {
	ctx := r.Context()
	claims, err := s.verifyMCPOAuthToken(ctx, st, token)
	if err != nil {
		return "", nil, err
	}
	// Whom the token was minted for. Measured against a real Keycloak 26: an
	// access token issued to a client carries that client in azp and
	// aud: ["account"] — the client id is not in aud, whatever an ID token does.
	// So the binding checked here is "aud names us, or the token was issued to a
	// client the administrator trusts (aud or azp)". Either is the token being
	// for this deployment rather than passed through from another application in
	// the realm, which is what RFC 8707 and the MCP specification guard against.
	audience, _ := audienceValues(claims["aud"])
	azp := strClaim(claims, "azp")
	accepted := []string{st.resourceFor(r.URL.Path), st.Resource}
	accepted = append(accepted, st.conf.Audience...)
	if st.ClientID != "" {
		accepted = append(accepted, st.ClientID)
	}
	bound := append(append([]string{}, audience...), azp)
	matched := false
	for _, value := range bound {
		if value != "" && hasScope(accepted, value) {
			matched = true
			break
		}
	}
	if !matched {
		return "", nil, &mcpOAuthRefusal{Code: "audience_mismatch", Message: fmt.Sprintf(
			"SSO 토큰이 이 서버를 위해 발급된 것이 아닙니다(aud=%v, azp=%q). 관리자가 %s 에 %q 를 더하거나, Keycloak 클라이언트에 Audience 매퍼로 %q 를 넣어야 합니다.",
			audience, azp, mcpOAuthAudienceKey, firstNonEmpty(azp, "<client id>"), st.resourceFor(r.URL.Path)),
			Cause: fmt.Sprintf("audience check failed: aud=%v azp=%q accepted=%v", audience, azp, accepted)}
	}
	sub := strClaim(claims, "sub")
	if !keycloakExactClaimValue(sub, 255) {
		return "", nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "SSO 토큰에 사용자 식별자(sub)가 없습니다.", Cause: "sub claim missing or malformed"}
	}
	// The same linkage the web sign-in wrote, without the provisioning half. The
	// realm issues one subject per person whatever client asked, so one web
	// sign-in is enough for every MCP client afterwards.
	identity, linked, err := s.db.AuthIdentityBySubject(ctx, "keycloak", st.Issuer, sub)
	if err != nil {
		return "", nil, err
	}
	if !linked {
		return "", nil, &mcpOAuthRefusal{Code: "account_not_linked", Message: "이 SSO 계정은 아직 이 게이트웨이에 등록되지 않았습니다. 먼저 웹 콘솔에 SSO 로 한 번 로그인한 뒤 다시 연결하세요.", Cause: fmt.Sprintf("no auth identity for issuer %s subject %q", st.Issuer, sub)}
	}
	user, found, err := s.db.AuthUserByID(ctx, identity.UserID)
	if err != nil {
		return "", nil, err
	}
	if !found || user.Status != "active" {
		return "", nil, &mcpOAuthRefusal{Code: "account_inactive", Message: "이 SSO 계정에 연결된 게이트웨이 계정이 비활성 상태입니다. 관리자에게 문의하세요.", Cause: fmt.Sprintf("linked account %s status=%q", identity.UserID, user.Status)}
	}
	teamID, err := s.db.PrimaryTeamForUser(ctx, user.ID)
	if err != nil {
		return "", nil, err
	}
	// Never wider than the account: the administrator's ceiling, cut to what the
	// account's role allows, cut again by the token if Keycloak was taught this
	// vocabulary. The token's role claims are deliberately not consulted.
	//
	// An empty intersection is a refusal, not an "unscoped" principal. /mcp/gateway
	// asks for no path scope of its own, so a subject with no scopes left would
	// otherwise walk in on the strength of the token alone — the case where the
	// administrator's ceiling and the account's role share nothing is exactly the
	// one where nothing should be granted.
	scopes := intersectScopes(st.conf.Scopes, s.effectiveScopesForRole(ctx, user.Role))
	if granted := tokenScopes(claims); len(granted) > 0 {
		scopes = intersectScopes(scopes, granted)
	}
	if len(scopes) == 0 {
		return "", nil, &mcpOAuthRefusal{Code: "scope_denied", Message: fmt.Sprintf("SSO 주체에게 남는 범위가 없습니다(%s=%v ∩ 계정 역할 %s 의 범위 = 없음). 관리자가 %s 와 계정 역할을 확인해야 합니다.", mcpOAuthScopesKey, st.conf.Scopes, user.Role, mcpOAuthScopesKey),
			Cause: fmt.Sprintf("scope intersection empty: ceiling=%v role=%s token_scope=%v", st.conf.Scopes, user.Role, tokenScopes(claims))}
	}
	if required := apiScopeForRequest(r); required != "" && !hasScope(scopes, required) {
		return "", nil, &mcpOAuthRefusal{Code: "scope_denied", Message: fmt.Sprintf("SSO 주체의 범위 %v 에 %s 가 없습니다. 관리자가 %s 와 계정 역할(%s)의 범위를 확인해야 합니다.", scopes, required, mcpOAuthScopesKey, user.Role),
			Cause: fmt.Sprintf("required scope %s not in %v (ceiling=%v role=%s)", required, scopes, st.conf.Scopes, user.Role)}
	}
	// APIKeyID/KeyTeam mirror what a key of this user would carry so the request
	// pipeline's quota guard (authCtx.APIKeyID == apiKeyID → team known) and
	// audit attribution treat the SSO subject like that key, not like nobody.
	id := ssoPrincipalID(user.ID)
	authCtx := store.AuthContext{UserID: user.ID, TeamID: teamID, KeyTeam: teamID, Role: user.Role, Scopes: scopes, APIKeyID: id}
	s.enrichAuthContextTeam(ctx, &authCtx)
	return id, &authCtx, nil
}

// verifyMCPOAuthToken is the token check proper: signature against Keycloak's
// JWKS, issuer and expiry (keycloakVerifyJWT), then what a bearer access token
// must additionally satisfy before it can stand in for a key.
func (s *Server) verifyMCPOAuthToken(ctx context.Context, st mcpOAuthState, token string) (map[string]any, error) {
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	parts := strings.Split(token, ".")
	if hb, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || json.Unmarshal(hb, &header) != nil {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "SSO 토큰의 헤더를 읽을 수 없습니다.", Cause: "jwt header is not base64url JSON"}
	}
	// keycloakVerifyJWT accepts RS256 only, which already rules out HS* and none;
	// the header is inspected here so the refusal can say which.
	if header.Alg != "RS256" {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: fmt.Sprintf("SSO 토큰 서명 알고리즘 %q 은 받지 않습니다(RS256 만 허용).", header.Alg), Cause: "unsupported alg " + header.Alg}
	}
	disc, err := keycloakDiscover(ctx, st.Issuer)
	if err != nil {
		return nil, &mcpOAuthRefusal{Code: "issuer_unavailable", Message: "Keycloak 발급자 정보를 읽지 못해 SSO 토큰을 확인할 수 없습니다. 잠시 후 다시 시도하거나 관리자에게 알리세요.", Cause: "discovery for " + st.Issuer + " failed: " + err.Error()}
	}
	claims, err := s.keycloakVerifyJWT(ctx, disc, token)
	if err != nil {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "SSO 액세스 토큰이 유효하지 않습니다(서명·발급자·만료: " + err.Error() + "). 클라이언트에서 다시 로그인하세요.", Cause: err.Error()}
	}
	if nbf, ok := claims["nbf"].(float64); ok && time.Now().Add(mcpOAuthClockSkew).Before(time.Unix(int64(nbf), 0)) {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "SSO 토큰이 아직 유효하지 않습니다(nbf). 클라이언트와 Keycloak 의 시계를 확인하세요.", Cause: fmt.Sprintf("nbf %d is in the future", int64(nbf))}
	}
	// An ID token proves a sign-in; it is not an API credential. Keycloak marks
	// one with typ=ID in the header and the claims alike.
	if strings.EqualFold(header.Typ, "ID") || strings.EqualFold(strClaim(claims, "typ"), "ID") {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "ID 토큰은 받지 않습니다. 액세스 토큰을 보내세요.", Cause: "typ=ID"}
	}
	// A token bound to a proof of possession (DPoP, mTLS) that this server cannot
	// verify is not a bearer token and must not be treated as one.
	if _, bound := claims["cnf"]; bound {
		return nil, &mcpOAuthRefusal{Code: "invalid_token", Message: "소지자 증명(cnf)이 묶인 토큰은 받지 않습니다. 일반 Bearer 액세스 토큰을 보내세요.", Cause: "cnf claim present"}
	}
	return claims, nil
}

// tokenScopes returns the part of the token's scope claim that is this
// gateway's vocabulary; empty means Keycloak was not taught it.
func tokenScopes(claims map[string]any) []string {
	var out []string
	for _, scope := range strings.Fields(strClaim(claims, "scope")) {
		if hasScope(allScopes, scope) {
			out = append(out, scope)
		}
	}
	return out
}

func intersectScopes(a, b []string) []string {
	out := []string{}
	for _, scope := range a {
		if hasScope(b, scope) && !hasScope(out, scope) {
			out = append(out, scope)
		}
	}
	return out
}

// mcpOAuthChallenge turns an MCP 401 into an invitation: the client reads
// resource_metadata and starts the OAuth flow from there. Without it a refusal
// is a dead end. Only the MCP paths call this — a REST 401 carrying it would
// send browsers and SDKs somewhere they cannot follow.
func (s *Server) mcpOAuthChallenge(w http.ResponseWriter, r *http.Request, refusal *mcpOAuthRefusal) {
	st := s.mcpOAuthState()
	if !st.Active() {
		return
	}
	value := fmt.Sprintf(`Bearer realm="vibe-coders", resource_metadata=%q`, st.metadataURL(r.URL.Path))
	if bearerToken(r.Header.Get("Authorization")) != "" {
		value += `, error="invalid_token"`
		if refusal != nil {
			value += fmt.Sprintf(`, error_description=%q`, strings.NewReplacer("\"", "'", "\n", " ").Replace(refusal.Message))
		}
	}
	w.Header().Set("WWW-Authenticate", value)
}

// writeMCPUnauthorized is the MCP endpoints' 401: the key-era body when a key
// was refused, the SSO refusal when a token was, and the challenge header in
// both cases while SSO tokens are accepted.
func (s *Server) writeMCPUnauthorized(w http.ResponseWriter, r *http.Request, refusal *mcpOAuthRefusal) {
	s.mcpOAuthChallenge(w, r, refusal)
	if refusal != nil {
		writeOpenAIError(w, http.StatusUnauthorized, refusal.Message, "invalid_request_error", refusal.Code)
		return
	}
	writeOpenAIError(w, http.StatusUnauthorized, "invalid proxy API key", "invalid_request_error", "invalid_api_key")
}

// handleProtectedResourceMetadata is RFC 9728: the document a refused MCP client
// reads to find the authorization server. Public by design — it says where to
// sign in, not who is signed in — and served as the bare document, not the
// product's envelope, because the reader is an OAuth client library.
// GET /.well-known/oauth-protected-resource[/mcp|/mcp/gateway]
func (s *Server) handleProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, protectedResourceMetadataPath)
	if path == "" || path == "/" {
		path = "/mcp"
	}
	st := s.mcpOAuthState()
	if !st.Active() || !isMCPPath(path) {
		http.NotFound(w, r)
		return
	}
	// Browser-hosted MCP clients read this cross-origin. Only the metadata is
	// opened this way; the MCP endpoints themselves are not.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"resource":                 st.resourceFor(path),
		"authorization_servers":    []string{st.Issuer},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         st.conf.Scopes,
		"resource_name":            "vibe-coders MCP",
	})
}

// handleMCPOAuthStatus is what the SSO settings card shows: whether SSO tokens
// are accepted, why not if not, and the values a person needs to copy into
// Keycloak or an MCP client. GET /admin/mcp/oauth
func (s *Server) handleMCPOAuthStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.mcpOAuthStatus())
}

func (s *Server) mcpOAuthStatus() map[string]any {
	st := s.mcpOAuthState()
	audience := st.conf.Audience
	if audience == nil {
		audience = []string{}
	}
	scopes := st.conf.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	status := map[string]any{
		"enabled":          st.conf.Enabled,
		"active":           st.Active(),
		"issuer":           st.Issuer,
		"client_id":        st.ClientID,
		"resource":         st.Resource,
		"resource_source":  "setting",
		"gateway_resource": "",
		"metadata_url":     "",
		"audience":         audience,
		"scopes":           scopes,
	}
	if st.conf.Resource == "" {
		status["resource_source"] = "derived"
	}
	if st.Resource != "" {
		status["gateway_resource"] = st.resourceFor("/mcp/gateway")
		status["metadata_url"] = st.metadataURL("/mcp")
	}
	if !st.Active() {
		status["reason"] = st.Reason
	}
	return status
}
