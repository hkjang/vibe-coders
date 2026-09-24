package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// A fake Keycloak: real RSA keys, a discovery document and a JWKS the gateway
// fetches over HTTP, and access tokens signed the way Keycloak 26 signs them
// (aud: ["account"], the client in azp). Nothing here is mocked inside the
// gateway — the token check runs exactly as it would against the real realm.

type fakeIdP struct {
	*httptest.Server
	key *rsa.PrivateKey
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIdP{key: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/realms/vibe/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer":                 idp.issuer(),
			"authorization_endpoint": idp.issuer() + "/protocol/openid-connect/auth",
			"token_endpoint":         idp.issuer() + "/protocol/openid-connect/token",
			"jwks_uri":               idp.issuer() + "/protocol/openid-connect/certs",
		})
	})
	mux.HandleFunc("/realms/vibe/protocol/openid-connect/certs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": "idp-kid", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}}})
	})
	idp.Server = httptest.NewServer(mux)
	t.Cleanup(idp.Close)
	invalidateOIDCCaches()
	t.Cleanup(invalidateOIDCCaches)
	return idp
}

func (idp *fakeIdP) issuer() string { return idp.URL + "/realms/vibe" }

// accessToken mints what Keycloak 26 hands a public MCP client: aud=account,
// the client id in azp, and any override the test wants.
func (idp *fakeIdP) accessToken(t *testing.T, overrides map[string]any) string {
	t.Helper()
	claims := map[string]any{
		"iss": idp.issuer(), "sub": "kc-subject-1", "typ": "Bearer", "azp": "claude-mcp",
		"aud": []any{"account"}, "scope": "openid profile email",
		"preferred_username": "dev", "email": "dev@example.com",
		"exp": float64(time.Now().Add(5 * time.Minute).Unix()),
		"iat": float64(time.Now().Unix()),
	}
	for k, v := range overrides {
		if v == nil {
			delete(claims, k)
		} else {
			claims[k] = v
		}
	}
	return signRS256(t, idp.key, "idp-kid", claims)
}

// mcpOAuthHarness is a gateway with accounts on, Keycloak SSO configured against
// the fake IdP, one SSO-linked user, and an administrator session for settings.
type mcpOAuthHarness struct {
	idp        *fakeIdP
	db         *store.SQLStore
	server     *Server
	ts         *httptest.Server
	adminToken string
	userID     string
}

func newMCPOAuthHarness(t *testing.T) *mcpOAuthHarness {
	t.Helper()
	return newMCPOAuthHarnessWith(t, nil)
}

// newMCPOAuthHarnessWith lets a test bend the gateway configuration before the
// server is built — the Keycloak block in particular, which the harness fills in
// the way a working web sign-in would.
func newMCPOAuthHarnessWith(t *testing.T, adjust func(*config.Config)) *mcpOAuthHarness {
	t.Helper()
	idp := newFakeIdP(t)
	// The LLM provider behind /v1: answers every completion so the gateway tools
	// that re-enter the pipeline (gateway_chat) have something to return.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cmpl-sso","object":"chat.completion","model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":"hello from upstream"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	t.Cleanup(upstream.Close)
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstream.URL, "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "test-jwt-secret"
	cfg.Auth.AccessTokenTTL = 15 * time.Minute
	cfg.Auth.RefreshTokenTTL = time.Hour
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	cfg.Auth.ServiceKeyPrefix = "vc_sa_"
	cfg.Auth.BootstrapEmail = "root@example.com"
	cfg.Auth.BootstrapPassword = "correct-password"
	cfg.Keycloak = config.KeycloakConfig{
		Enabled: true, IssuerURL: idp.issuer(), ClientID: "vibe-console",
		RedirectURI: "https://gateway.example/auth/keycloak/callback",
		Scopes:      []string{"openid", "profile", "email"}, DefaultRole: "developer",
		RoleClaim: "realm_access.roles", GroupClaim: "groups", AllowLocalLogin: true,
	}
	if adjust != nil {
		adjust(&cfg)
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)

	// The account a web sign-in would have provisioned and linked.
	user := store.AuthUser{ID: "usr_sso_dev", Email: "dev@example.com", Name: "Dev", Role: "developer", Status: "active"}
	if err := db.CreateAuthUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAuthIdentity(context.Background(), store.AuthIdentity{
		ID: "authid_dev", UserID: user.ID, Provider: "keycloak", Issuer: idp.issuer(), Subject: "kc-subject-1", Email: user.Email, PreferredUsername: "dev",
	}); err != nil {
		t.Fatal(err)
	}

	login := postJSON(t, ts.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var tokens struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	return &mcpOAuthHarness{idp: idp, db: db, server: server, ts: ts, adminToken: tokens.AccessToken, userID: user.ID}
}

func (h *mcpOAuthHarness) putSetting(t *testing.T, key, value string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"value": value, "reason": "mcp oauth test"})
	req, _ := http.NewRequest(http.MethodPut, h.ts.URL+"/admin/settings/by-key/"+key, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.adminToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT %s=%q: %d %s", key, value, resp.StatusCode, out)
	}
}

func (h *mcpOAuthHarness) enable(t *testing.T) {
	t.Helper()
	h.putSetting(t, mcpOAuthEnabledKey, "true")
}

// mcp posts one JSON-RPC message with the bearer given and returns the response.
func (h *mcpOAuthHarness) call(t *testing.T, path, bearer, method string) (*http.Response, map[string]any) {
	t.Helper()
	return h.callWith(t, path, bearer, method, nil)
}

// callWith is call with extra request headers (Host is honoured as the request's Host).
func (h *mcpOAuthHarness) callWith(t *testing.T, path, bearer, method string, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"` + method + `"}`
	req, _ := http.NewRequest(http.MethodPost, h.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	_ = json.Unmarshal(raw, &out)
	return resp, out
}

func (h *mcpOAuthHarness) get(t *testing.T, path, bearer string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, h.ts.URL+path, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	_ = json.Unmarshal(raw, &out)
	return resp, out
}

func errorMessage(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	msg, _ := e["message"].(string)
	return msg
}

func TestMCPOAuthIsOffByDefault(t *testing.T) {
	h := newMCPOAuthHarness(t)

	if resp, _ := h.get(t, protectedResourceMetadataPath, ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("metadata while off = %d, want 404", resp.StatusCode)
	}
	if resp, _ := h.get(t, protectedResourceMetadataPath+"/mcp", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("metadata/mcp while off = %d, want 404", resp.StatusCode)
	}
	// A valid token is refused exactly as an unknown key was, without a challenge.
	resp, out := h.call(t, "/mcp", h.idp.accessToken(t, nil), "tools/list")
	if resp.StatusCode != http.StatusUnauthorized || errorMessage(out) != "invalid proxy API key" || resp.Header.Get("WWW-Authenticate") != "" {
		t.Fatalf("token while off: status=%d body=%v www-authenticate=%q", resp.StatusCode, out, resp.Header.Get("WWW-Authenticate"))
	}
	if resp, _ := h.call(t, "/mcp", "", "tools/list"); resp.Header.Get("WWW-Authenticate") != "" {
		t.Fatal("no challenge header while SSO tokens are off")
	}
	_, status := h.get(t, "/admin/mcp/oauth", h.adminToken)
	if status["enabled"] != false || status["active"] != false || status["reason"] == nil {
		t.Fatalf("status while off = %v", status)
	}
}

func TestMCPOAuthMetadataAndChallenge(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)

	for _, path := range []string{protectedResourceMetadataPath, protectedResourceMetadataPath + "/mcp"} {
		resp, doc := h.get(t, path, "")
		if resp.StatusCode != http.StatusOK || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("GET %s = %d cors=%q", path, resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
		}
		// Bare RFC 9728 document: derived from the Keycloak redirect URI's origin, not the request host.
		if doc["resource"] != "https://gateway.example/mcp" {
			t.Fatalf("resource = %v", doc["resource"])
		}
		servers, _ := doc["authorization_servers"].([]any)
		if len(servers) != 1 || servers[0] != h.idp.issuer() {
			t.Fatalf("authorization_servers = %v", doc["authorization_servers"])
		}
		if methods, _ := doc["bearer_methods_supported"].([]any); len(methods) != 1 || methods[0] != "header" {
			t.Fatalf("bearer_methods_supported = %v", doc["bearer_methods_supported"])
		}
		if scopes, _ := doc["scopes_supported"].([]any); len(scopes) != 1 || scopes[0] != "mcp:use" {
			t.Fatalf("scopes_supported = %v", doc["scopes_supported"])
		}
		if _, enveloped := doc["data"]; enveloped {
			t.Fatal("metadata must be the bare document, not the product envelope")
		}
	}
	if _, doc := h.get(t, protectedResourceMetadataPath+"/mcp/gateway", ""); doc["resource"] != "https://gateway.example/mcp/gateway" {
		t.Fatalf("gateway resource = %v", doc["resource"])
	}
	if resp, _ := h.get(t, protectedResourceMetadataPath+"/v1/models", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("metadata for a non-MCP path = %d, want 404", resp.StatusCode)
	}

	// 401 without a token points at the metadata; with a refused token it adds error="invalid_token".
	resp, _ := h.call(t, "/mcp", "", "tools/list")
	challenge := resp.Header.Get("WWW-Authenticate")
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(challenge, `resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"`) || strings.Contains(challenge, "invalid_token") {
		t.Fatalf("anonymous challenge = %d %q", resp.StatusCode, challenge)
	}
	resp, _ = h.call(t, "/mcp/gateway", "vc_sk_not-a-real-key", "tools/list")
	challenge = resp.Header.Get("WWW-Authenticate")
	if !strings.Contains(challenge, `resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp/gateway"`) || !strings.Contains(challenge, `error="invalid_token"`) {
		t.Fatalf("bad key challenge = %q", challenge)
	}
	// REST 401s never carry it — nor accept the token.
	resp, _ = h.get(t, "/v1/models", h.idp.accessToken(t, nil))
	if resp.StatusCode == http.StatusOK && resp.Header.Get("WWW-Authenticate") != "" {
		t.Fatalf("REST path must not carry the MCP challenge: %q", resp.Header.Get("WWW-Authenticate"))
	}
	chat, _ := http.NewRequest(http.MethodPost, h.ts.URL+"/v1/chat/completions", strings.NewReader(`{"model":"test-model","messages":[{"role":"user","content":"hi"}]}`))
	chat.Header.Set("Authorization", "Bearer "+h.idp.accessToken(t, map[string]any{"aud": []any{"https://gateway.example/mcp"}}))
	chat.Header.Set("Content-Type", "application/json")
	chatResp, err := http.DefaultClient.Do(chat)
	if err != nil {
		t.Fatal(err)
	}
	chatResp.Body.Close()
	if chatResp.StatusCode != http.StatusUnauthorized || chatResp.Header.Get("WWW-Authenticate") != "" {
		t.Fatalf("valid SSO token on REST = %d www-authenticate=%q, want 401 without challenge", chatResp.StatusCode, chatResp.Header.Get("WWW-Authenticate"))
	}

	_, status := h.get(t, "/admin/mcp/oauth", h.adminToken)
	if status["active"] != true || status["metadata_url"] != "https://gateway.example/.well-known/oauth-protected-resource/mcp" || status["resource_source"] != "derived" {
		t.Fatalf("status = %v", status)
	}
}

func TestMCPOAuthAcceptsTokenForThisResource(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)

	// The canonical path: an Audience mapper put the resource identifier in aud.
	token := h.idp.accessToken(t, map[string]any{"aud": []any{"account", "https://gateway.example/mcp"}})
	resp, out := h.call(t, "/mcp", token, "tools/list")
	if resp.StatusCode != http.StatusOK || out["result"] == nil {
		t.Fatalf("tools/list with audience-mapped token = %d %v", resp.StatusCode, out)
	}
	resp, out = h.call(t, "/mcp/gateway", token, "tools/list")
	if resp.StatusCode != http.StatusOK || out["result"] == nil {
		t.Fatalf("/mcp/gateway with audience-mapped token = %d %v", resp.StatusCode, out)
	}
	// A key still works exactly as before.
	createKey := postJSON(t, h.ts.URL+"/admin/api-keys", h.adminToken, map[string]any{"name": "still-works"})
	var created struct {
		Secret string `json:"secret"`
	}
	_ = json.NewDecoder(createKey.Body).Decode(&created)
	createKey.Body.Close()
	if resp, out := h.call(t, "/mcp", created.Secret, "tools/list"); resp.StatusCode != http.StatusOK || out["result"] == nil {
		t.Fatalf("key after enabling SSO tokens = %d %v", resp.StatusCode, out)
	}
	// No account was created or changed by the token.
	user, _, _ := h.db.AuthUserByID(context.Background(), h.userID)
	if user.Role != "developer" {
		t.Fatalf("token must not change the account, role = %s", user.Role)
	}
}

func TestMCPOAuthRejectsOtherAudienceAndExplains(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)

	// Keycloak 26 default: aud=account, client in azp — and the administrator has not listed it.
	resp, out := h.call(t, "/mcp", h.idp.accessToken(t, nil), "tools/list")
	msg := errorMessage(out)
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(msg, "aud=[account]") || !strings.Contains(msg, `azp="claude-mcp"`) ||
		!strings.Contains(msg, `mcp.oauth.audience 에 "claude-mcp"`) || !strings.Contains(msg, "https://gateway.example/mcp") {
		t.Fatalf("other-audience refusal = %d %q", resp.StatusCode, msg)
	}
	if challenge := resp.Header.Get("WWW-Authenticate"); !strings.Contains(challenge, `error="invalid_token"`) || !strings.Contains(challenge, "claude-mcp") {
		t.Fatalf("challenge = %q", challenge)
	}
	// A token minted for another application in the realm, with a mapper for that application.
	resp, out = h.call(t, "/mcp", h.idp.accessToken(t, map[string]any{"aud": []any{"https://other.example/mcp"}, "azp": "other-app"}), "tools/list")
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(errorMessage(out), "other-app") {
		t.Fatalf("other app's token = %d %v", resp.StatusCode, out)
	}

	// The compatibility path: the administrator names the MCP client id.
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp cursor-mcp")
	if resp, out := h.call(t, "/mcp", h.idp.accessToken(t, nil), "tools/list"); resp.StatusCode != http.StatusOK || out["result"] == nil {
		t.Fatalf("azp in mcp.oauth.audience = %d %v", resp.StatusCode, out)
	}
	if resp, _ := h.call(t, "/mcp", h.idp.accessToken(t, map[string]any{"azp": "other-app"}), "tools/list"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unlisted azp = %d, want 401", resp.StatusCode)
	}
}

func TestMCPOAuthRejectsBadTokens(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp")
	good := map[string]any{}

	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	cases := map[string]struct {
		token string
		want  string
	}{
		"expired":        {h.idp.accessToken(t, map[string]any{"exp": float64(time.Now().Add(-time.Hour).Unix())}), "만료"},
		"not yet valid":  {h.idp.accessToken(t, map[string]any{"nbf": float64(time.Now().Add(time.Hour).Unix())}), "nbf"},
		"other issuer":   {h.idp.accessToken(t, map[string]any{"iss": "https://evil.example/realms/vibe"}), "발급자"},
		"id token":       {h.idp.accessToken(t, map[string]any{"typ": "ID", "aud": []any{"vibe-console"}}), "ID 토큰"},
		"bound token":    {h.idp.accessToken(t, map[string]any{"cnf": map[string]any{"jkt": "x"}}), "cnf"},
		"missing sub":    {h.idp.accessToken(t, map[string]any{"sub": nil}), "sub"},
		"wrong key":      {signRS256(t, otherKey, "idp-kid", map[string]any{"iss": h.idp.issuer(), "sub": "kc-subject-1", "azp": "claude-mcp", "aud": "account", "exp": float64(time.Now().Add(time.Hour).Unix())}), "서명"},
		"hs256":          {h.server.mustSignHS256(t, map[string]any{"iss": h.idp.issuer(), "sub": "kc-subject-1", "azp": "claude-mcp", "aud": "account", "exp": float64(time.Now().Add(time.Hour).Unix())}), "RS256"},
		"not a jwt":      {"eyJhbGciOiJSUzI1NiJ9.only-two-parts", "invalid proxy API key"},
		"key-shaped":     {"vc_sk_definitely-not-a-key", "invalid proxy API key"},
		"unlinked sub":   {h.idp.accessToken(t, map[string]any{"sub": "kc-subject-unknown"}), "웹 콘솔에 SSO 로 한 번 로그인"},
		"good (control)": {h.idp.accessToken(t, good), ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp, out := h.call(t, "/mcp", tc.token, "tools/list")
			if tc.want == "" {
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("control token = %d %v", resp.StatusCode, out)
				}
				return
			}
			if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(errorMessage(out), tc.want) {
				t.Fatalf("status=%d message=%q, want 401 containing %q", resp.StatusCode, errorMessage(out), tc.want)
			}
		})
	}
	// Nothing was provisioned for the unknown subject.
	if _, found, _ := h.db.AuthIdentityBySubject(context.Background(), "keycloak", h.idp.issuer(), "kc-subject-unknown"); found {
		t.Fatal("a token must never create an account or identity")
	}
}

func TestMCPOAuthRefusesInactiveAccountAndKeepsRoleOutOfToken(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp")

	// Claims that would make an admin at web sign-in are ignored here: the
	// principal carries the stored role and the administrator's scope ceiling.
	elevated := h.idp.accessToken(t, map[string]any{"realm_access": map[string]any{"roles": []any{"vibe-admin"}}, "scope": "openid admin:write mcp:use"})
	r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	r.Header.Set("Authorization", "Bearer "+elevated)
	id, authCtx, outcome, refusal := h.server.authenticateMCP(r)
	if outcome != authOK || refusal != nil || authCtx == nil {
		t.Fatalf("elevated token: outcome=%v refusal=%v", outcome, refusal)
	}
	if id != "sso_"+h.userID || authCtx.UserID != h.userID || authCtx.Role != "developer" || strings.Join(authCtx.Scopes, " ") != "mcp:use" {
		t.Fatalf("principal = %s %+v", id, authCtx)
	}

	// A wider administrator ceiling is still cut to the account's role.
	h.putSetting(t, mcpOAuthScopesKey, "mcp:use admin:write")
	_, authCtx, _, _ = h.server.authenticateMCP(r)
	if hasScope(authCtx.Scopes, "admin:write") {
		t.Fatalf("scopes must not exceed the account's role: %v", authCtx.Scopes)
	}
	// And a ceiling without mcp:use closes the door the same way a key without it is closed.
	h.putSetting(t, mcpOAuthScopesKey, "models:read")
	if resp, out := h.call(t, "/mcp", h.idp.accessToken(t, nil), "tools/list"); resp.StatusCode != http.StatusUnauthorized || !strings.Contains(errorMessage(out), "mcp:use") {
		t.Fatalf("scope ceiling without mcp:use = %d %v", resp.StatusCode, out)
	}
	h.putSetting(t, mcpOAuthScopesKey, "mcp:use")

	// A disabled account stays disabled.
	if err := h.db.UpdateAuthUserRoleStatus(context.Background(), h.userID, "developer", "disabled"); err != nil {
		t.Fatal(err)
	}
	resp, out := h.call(t, "/mcp", h.idp.accessToken(t, nil), "tools/list")
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(errorMessage(out), "비활성") {
		t.Fatalf("disabled account = %d %v", resp.StatusCode, out)
	}
	if user, _, _ := h.db.AuthUserByID(context.Background(), h.userID); user.Status != "disabled" {
		t.Fatalf("token must not revive the account: %s", user.Status)
	}
}

func TestMCPOAuthSettingsValidationAndResourceOverride(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)

	body, _ := json.Marshal(map[string]string{"value": "mcp:use no:such", "reason": "x"})
	req, _ := http.NewRequest(http.MethodPut, h.ts.URL+"/admin/settings/by-key/"+mcpOAuthScopesKey, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.adminToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown scope accepted: %d", resp.StatusCode)
	}

	h.putSetting(t, mcpOAuthResourceKey, "https://ai.corp.example/mcp/")
	_, doc := h.get(t, protectedResourceMetadataPath+"/mcp", "")
	if doc["resource"] != "https://ai.corp.example/mcp" {
		t.Fatalf("explicit resource = %v", doc["resource"])
	}
	resp, _ = h.call(t, "/mcp", "", "tools/list")
	if !strings.Contains(resp.Header.Get("WWW-Authenticate"), `resource_metadata="https://ai.corp.example/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("challenge after override = %q", resp.Header.Get("WWW-Authenticate"))
	}
	if resp, _ := h.call(t, "/mcp", h.idp.accessToken(t, map[string]any{"aud": []any{"https://ai.corp.example/mcp"}}), "tools/list"); resp.StatusCode != http.StatusOK {
		t.Fatalf("token for the overridden resource = %d", resp.StatusCode)
	}
	if resp, _ := h.call(t, "/mcp", h.idp.accessToken(t, map[string]any{"aud": []any{"https://gateway.example/mcp"}}), "tools/list"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token for the old derived resource = %d, want 401", resp.StatusCode)
	}
}

func TestMCPOAuthNeverDerivesTheResourceFromTheRequestHost(t *testing.T) {
	// Neither mcp.oauth.resource nor a Keycloak redirect URI: the environment
	// path lets SSO be enabled with SSO_KEYCLOAK_REDIRECT_URI empty, so this is a
	// reachable deployment, not a hypothetical one. The gateway must not fill the
	// gap from Host / X-Forwarded-*: those are the caller's to choose, and an
	// identifier built from them would let a token minted for whatever aud the
	// caller names walk in.
	h := newMCPOAuthHarnessWith(t, func(cfg *config.Config) { cfg.Keycloak.RedirectURI = "" })
	h.enable(t)

	_, status := h.get(t, "/admin/mcp/oauth", h.adminToken)
	reason, _ := status["reason"].(string)
	if status["active"] != false || !strings.Contains(reason, mcpOAuthResourceKey) || status["resource"] != "" {
		t.Fatalf("status without a derivable resource = %v, want active=false with a reason naming %s", status, mcpOAuthResourceKey)
	}
	if resp, _ := h.get(t, protectedResourceMetadataPath+"/mcp", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("metadata without a derivable resource = %d, want 404", resp.StatusCode)
	}

	// A token whose aud matches whatever origin the request claims — the
	// listener's own address, a chosen Host, or a forwarded host/proto — is refused.
	for name, headers := range map[string]map[string]string{
		"listener origin":  nil,
		"chosen host":      {"Host": "attacker.example"},
		"forwarded origin": {"X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https"},
	} {
		t.Run(name, func(t *testing.T) {
			origin := strings.TrimSuffix(h.ts.URL, "/")
			if hostHeader := headers["Host"]; hostHeader != "" {
				origin = "http://" + hostHeader
			}
			if fwd := headers["X-Forwarded-Host"]; fwd != "" {
				origin = headers["X-Forwarded-Proto"] + "://" + fwd
			}
			token := h.idp.accessToken(t, map[string]any{"aud": []any{origin + "/mcp"}})
			resp, out := h.callWith(t, "/mcp", token, "tools/list", headers)
			if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") != "" {
				t.Fatalf("token for aud %s/mcp = %d %v www-authenticate=%q, want 401 without a challenge", origin, resp.StatusCode, out, resp.Header.Get("WWW-Authenticate"))
			}
		})
	}

	// Writing the identifier down is what opens the door — nothing request-derived does.
	h.putSetting(t, mcpOAuthResourceKey, "https://ai.corp.example/mcp")
	if _, status := h.get(t, "/admin/mcp/oauth", h.adminToken); status["active"] != true || status["resource"] != "https://ai.corp.example/mcp" {
		t.Fatalf("status after setting the resource = %v", status)
	}
	if resp, _ := h.callWith(t, "/mcp", h.idp.accessToken(t, map[string]any{"aud": []any{"https://ai.corp.example/mcp"}}), "tools/list", map[string]string{"Host": "attacker.example"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("token for the configured resource = %d, want 200 whatever the Host", resp.StatusCode)
	}
}

// mustSignHS256 mints a token in the gateway's own session-token format so the
// test can show an HS256 signature is never accepted as an SSO token.
func (s *Server) mustSignHS256(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString([]byte("signature"))
}

// callTool posts a tools/call for one gateway tool with the bearer given.
func (h *mcpOAuthHarness) callTool(t *testing.T, path, bearer, tool string, args map[string]any) (*http.Response, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
	req, _ := http.NewRequest(http.MethodPost, h.ts.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	_ = json.Unmarshal(raw, &out)
	return resp, out
}

// toolText flattens a tools/call result's content into one string, or the
// JSON-RPC/tool error message.
func toolText(out map[string]any) string {
	if e, ok := out["error"].(map[string]any); ok {
		msg, _ := e["message"].(string)
		return msg
	}
	result, _ := out["result"].(map[string]any)
	content, _ := result["content"].([]any)
	var parts []string
	for _, item := range content {
		if m, ok := item.(map[string]any); ok {
			if text, ok := m["text"].(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func TestMCPOAuthEmptyScopeIntersectionIsRefusedNotUnscoped(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp")

	// The administrator's ceiling shares nothing with the developer role.
	// /mcp/gateway asks for no path scope of its own, so this is the case where an
	// empty intersection handed downstream would open every gateway tool.
	h.putSetting(t, mcpOAuthScopesKey, "mcp:admin")
	for _, path := range []string{"/mcp/gateway", "/mcp"} {
		resp, out := h.call(t, path, h.idp.accessToken(t, nil), "tools/list")
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(errorMessage(out), "남는 범위가 없습니다") {
			t.Fatalf("%s with an empty scope intersection = %d %q, want 401 refusal", path, resp.StatusCode, errorMessage(out))
		}
		if code, _ := out["error"].(map[string]any)["code"].(string); code != "scope_denied" {
			t.Fatalf("%s refusal code = %q", path, code)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/mcp/gateway", nil)
	r.Header.Set("Authorization", "Bearer "+h.idp.accessToken(t, nil))
	if _, authCtx, outcome, _ := h.server.authenticateMCP(r); outcome == authOK || authCtx != nil {
		t.Fatalf("an empty intersection must not yield a principal: outcome=%v ctx=%+v", outcome, authCtx)
	}

	// Restoring an overlapping ceiling reopens the door — the refusal was about the
	// intersection, not the account.
	h.putSetting(t, mcpOAuthScopesKey, "mcp:use")
	if resp, _ := h.call(t, "/mcp/gateway", h.idp.accessToken(t, nil), "tools/list"); resp.StatusCode != http.StatusOK {
		t.Fatalf("after restoring the ceiling = %d", resp.StatusCode)
	}
}

func TestMCPOAuthGatewayToolsRunAsTheSSOSubject(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp")
	token := h.idp.accessToken(t, nil)

	// gateway_chat re-enters /v1/chat/completions in-process. With the default
	// ceiling (mcp:use only) the subject lacks chat:completion, so the pipeline's
	// own scope gate refuses — the same gate a key without that scope hits.
	resp, out := h.callTool(t, "/mcp/gateway", token, "gateway_chat", map[string]any{"model": "test-model", "prompt": "hi"})
	if resp.StatusCode != http.StatusOK || !strings.Contains(toolText(out), "HTTP 401") {
		t.Fatalf("gateway_chat without chat:completion = %d %q, want a refused completion", resp.StatusCode, toolText(out))
	}
	events, err := h.db.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	var denied bool
	for _, e := range events {
		if e.EventType == "scope_denied" && e.ActorUserID == h.userID && strings.Contains(e.Detail, "chat:completion") {
			denied = true
		}
	}
	if !denied {
		t.Fatalf("scope refusal of the re-entry must be audited against the account: %+v", events)
	}

	// Granting the scope lets the same token run the completion as the account —
	// no key exists for this subject, so nothing but the carried principal can
	// have opened the door.
	h.putSetting(t, mcpOAuthScopesKey, "mcp:use chat:completion")
	resp, out = h.callTool(t, "/mcp/gateway", token, "gateway_chat", map[string]any{"model": "test-model", "prompt": "hi"})
	if resp.StatusCode != http.StatusOK || !strings.Contains(toolText(out), "hello from upstream") {
		t.Fatalf("gateway_chat with chat:completion = %d %q", resp.StatusCode, toolText(out))
	}
	// The REST door itself still refuses the token: the principal travels only on
	// the in-process re-entry, never on a request from outside.
	chat, _ := http.NewRequest(http.MethodPost, h.ts.URL+"/v1/chat/completions", strings.NewReader(`{"model":"test-model","messages":[{"role":"user","content":"hi"}]}`))
	chat.Header.Set("Authorization", "Bearer "+token)
	chat.Header.Set("Content-Type", "application/json")
	chatResp, err := http.DefaultClient.Do(chat)
	if err != nil {
		t.Fatal(err)
	}
	chatResp.Body.Close()
	if chatResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("SSO token on /v1/chat/completions = %d, want 401", chatResp.StatusCode)
	}
	// A key going through the same tool is re-authenticated as before.
	createKey := postJSON(t, h.ts.URL+"/admin/api-keys", h.adminToken, map[string]any{"name": "chat-key"})
	var created struct {
		Secret string `json:"secret"`
	}
	_ = json.NewDecoder(createKey.Body).Decode(&created)
	createKey.Body.Close()
	if resp, out := h.callTool(t, "/mcp/gateway", created.Secret, "gateway_chat", map[string]any{"model": "test-model", "prompt": "hi"}); resp.StatusCode != http.StatusOK || !strings.Contains(toolText(out), "hello from upstream") {
		t.Fatalf("gateway_chat with a key = %d %q", resp.StatusCode, toolText(out))
	}
}

func TestMCPOAuthRefusalLogsTheCause(t *testing.T) {
	h := newMCPOAuthHarness(t)
	h.enable(t)
	h.putSetting(t, mcpOAuthAudienceKey, "claude-mcp")

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)

	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	cases := []struct {
		name, token, code, cause string
		// requestID is sent as X-Request-ID; empty lets the gateway mint one.
		requestID string
	}{
		{"wrong key", signRS256(t, otherKey, "idp-kid", map[string]any{"iss": h.idp.issuer(), "sub": "kc-subject-1", "azp": "claude-mcp", "aud": "account", "exp": float64(time.Now().Add(time.Hour).Unix())}), "invalid_token", "jwt signature verification failed", ""},
		{"other issuer", h.idp.accessToken(t, map[string]any{"iss": "https://evil.example/realms/vibe"}), "invalid_token", "jwt issuer mismatch", ""},
		{"expired", h.idp.accessToken(t, map[string]any{"exp": float64(time.Now().Add(-time.Hour).Unix())}), "invalid_token", "jwt expired", ""},
		{"other audience", h.idp.accessToken(t, map[string]any{"azp": "some-other-app"}), "audience_mismatch", "azp=\\\"some-other-app\\\"", ""},
		{"unlinked", h.idp.accessToken(t, map[string]any{"sub": "kc-subject-unknown"}), "account_not_linked", "subject \\\"kc-subject-unknown\\\"", ""},
		{"caller's request id", h.idp.accessToken(t, map[string]any{"azp": "some-other-app"}), "audience_mismatch", "azp=\\\"some-other-app\\\"", "req-mcp-oauth-42"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logs.Reset()
			var headers map[string]string
			if tc.requestID != "" {
				headers = map[string]string{"X-Request-ID": tc.requestID}
			}
			resp, _ := h.callWith(t, "/mcp", tc.token, "tools/list", headers)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", resp.StatusCode)
			}
			got := logs.String()
			if !strings.Contains(got, "mcp oauth token refused") || !strings.Contains(got, "code="+tc.code) || !strings.Contains(got, tc.cause) {
				t.Fatalf("operator log must name the failed check:\n%s\nwant code=%s and %q", got, tc.code, tc.cause)
			}
			// The refusal is tied to the request the client saw fail: the same id the
			// response carries in X-Request-ID — the caller's when it sent one.
			requestID := refusalLogField(got, "request_id")
			if requestID == "" {
				t.Fatalf("operator log must carry a non-empty request_id:\n%s", got)
			}
			if want := resp.Header.Get("X-Request-ID"); requestID != want {
				t.Fatalf("request_id=%q in the log, but the response carried X-Request-ID %q", requestID, want)
			}
			if tc.requestID != "" && requestID != tc.requestID {
				t.Fatalf("request_id=%q, want the caller's %q", requestID, tc.requestID)
			}
		})
	}
}

// refusalLogField pulls key=value out of the "mcp oauth token refused" line of a
// slog text log; "" when the line or the key is absent or the value is empty.
func refusalLogField(logs, key string) string {
	for _, line := range strings.Split(logs, "\n") {
		if !strings.Contains(line, "mcp oauth token refused") {
			continue
		}
		for _, field := range strings.Fields(line) {
			if value, ok := strings.CutPrefix(field, key+"="); ok {
				return strings.Trim(value, `"`)
			}
		}
	}
	return ""
}
