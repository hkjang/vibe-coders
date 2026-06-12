package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func newAuthTestServer(t *testing.T, upstreamURL string) (*store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstreamURL, "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "test-jwt-secret"
	cfg.Auth.AccessTokenTTL = 15 * time.Minute
	cfg.Auth.RefreshTokenTTL = time.Hour
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	cfg.Auth.ServiceKeyPrefix = "vc_sa_"
	cfg.Auth.BootstrapEmail = "root@example.com"
	cfg.Auth.BootstrapPassword = "correct-password"
	cfg.Pricing = map[string]config.ModelPrice{
		"gpt-4.1-mini": {InputKRWPer1M: 1, OutputKRWPer1M: 1},
		"gpt-blocked":  {InputKRWPer1M: 1, OutputKRWPer1M: 1},
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return db, httptest.NewServer(server.Routes())
}

// TestAdminLoginFlowBootContract pins the contract the admin UI boot sequence
// relies on to route the operator straight to the login page:
//   - auth mode: GET /auth/me without a token → 401 (UI shows the login overlay)
//   - the /admin HTML itself loads without auth and contains the login form
//   - after login, /auth/me returns auth_enabled + user identity for the header chip
//   - legacy mode (auth disabled): /auth/me → 200 {auth_enabled:false} (token input UI)
func TestAdminLoginFlowBootContract(t *testing.T) {
	_, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()

	// 1) auth mode + no token → 401 drives the UI to the login overlay
	me, err := http.Get(proxy.URL + "/auth/me")
	if err != nil {
		t.Fatal(err)
	}
	me.Body.Close()
	if me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/auth/me without token should be 401 in auth mode, got %d", me.StatusCode)
	}

	// 2) the admin HTML must render without auth so the login form can appear
	page, err := http.Get(proxy.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if page.StatusCode != http.StatusOK {
		t.Fatalf("/admin page should load without auth, got %d", page.StatusCode)
	}
	for _, needle := range []string{"login-form", "login-email", "login-password", "initAuth()"} {
		if !strings.Contains(string(html), needle) {
			t.Fatalf("admin HTML missing %q (login flow not wired)", needle)
		}
	}

	// 3) login → /auth/me returns identity for the header chip
	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var tokens struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	req, _ := http.NewRequest(http.MethodGet, proxy.URL+"/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	me2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var meOut struct {
		AuthEnabled bool `json:"auth_enabled"`
		User        struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		} `json:"user"`
	}
	if err := json.NewDecoder(me2.Body).Decode(&meOut); err != nil {
		t.Fatal(err)
	}
	me2.Body.Close()
	if !meOut.AuthEnabled || meOut.User.Email != "root@example.com" || meOut.User.Role != "super_admin" {
		t.Fatalf("unexpected /auth/me after login: %+v", meOut)
	}
}

// TestAuthUserRoleChangeAndDeactivation covers the account-management flow added
// to the settings tab: create → role change (audited) → deactivate (sessions die).
func TestAuthUserRoleChangeAndDeactivation(t *testing.T) {
	db, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()

	// login as bootstrap super_admin
	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var rootTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(login.Body).Decode(&rootTok)
	login.Body.Close()

	// create a developer account
	create := postJSON(t, proxy.URL+"/admin/users", rootTok.AccessToken, map[string]string{
		"email": "dev@example.com", "password": "dev-password", "name": "Dev", "role": "developer",
	})
	if create.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(create.Body)
		t.Fatalf("user create failed: %d %s", create.StatusCode, b)
	}
	var created struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(create.Body).Decode(&created)
	create.Body.Close()

	// the new account can log in
	devLogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "dev@example.com", "password": "dev-password"})
	var devTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(devLogin.Body).Decode(&devTok)
	devLogin.Body.Close()
	if devTok.AccessToken == "" {
		t.Fatal("dev login should succeed")
	}

	// role change developer → admin, audited as role_changed
	patch, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/users/"+created.User.ID, strings.NewReader(`{"role":"admin"}`))
	patch.Header.Set("Authorization", "Bearer "+rootTok.AccessToken)
	patch.Header.Set("Content-Type", "application/json")
	pr, err := http.DefaultClient.Do(patch)
	if err != nil {
		t.Fatal(err)
	}
	pr.Body.Close()
	if pr.StatusCode != http.StatusOK {
		t.Fatalf("role patch failed: %d", pr.StatusCode)
	}
	user, _, _ := db.AuthUserByID(context.Background(), created.User.ID)
	if user.Role != "admin" {
		t.Fatalf("role not updated: %q", user.Role)
	}
	events, _ := db.ListAuditEvents(context.Background(), 50)
	foundRoleChange := false
	for _, e := range events {
		if e.EventType == "role_changed" && e.ActorUserID == created.User.ID && strings.Contains(e.Detail, "developer → admin") {
			foundRoleChange = true
		}
	}
	if !foundRoleChange {
		t.Fatalf("role_changed audit event missing: %+v", events)
	}

	// deactivate → live access token dies immediately (session revoked)
	patch2, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/users/"+created.User.ID, strings.NewReader(`{"status":"disabled"}`))
	patch2.Header.Set("Authorization", "Bearer "+rootTok.AccessToken)
	patch2.Header.Set("Content-Type", "application/json")
	pr2, err := http.DefaultClient.Do(patch2)
	if err != nil {
		t.Fatal(err)
	}
	pr2.Body.Close()
	if pr2.StatusCode != http.StatusOK {
		t.Fatalf("status patch failed: %d", pr2.StatusCode)
	}
	meReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+devTok.AccessToken)
	meRes, err := http.DefaultClient.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	meRes.Body.Close()
	if meRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("deactivated user's access token should be rejected, got %d", meRes.StatusCode)
	}
	// and a fresh login is refused
	relogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "dev@example.com", "password": "dev-password"})
	relogin.Body.Close()
	if relogin.StatusCode != http.StatusUnauthorized {
		t.Fatalf("deactivated user login should fail, got %d", relogin.StatusCode)
	}
}

func TestAdminLoginRefreshRotationLogoutAndJWTRequired(t *testing.T) {
	_, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()

	noJWT, err := http.Get(proxy.URL + "/admin/users")
	if err != nil {
		t.Fatal(err)
	}
	noJWT.Body.Close()
	if noJWT.StatusCode != http.StatusUnauthorized {
		t.Fatalf("admin API should require JWT when auth enabled, got %d", noJWT.StatusCode)
	}

	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	defer login.Body.Close()
	if login.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(login.Body)
		t.Fatalf("login failed: %d %s", login.StatusCode, body)
	}
	var tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokens.AccessToken == "" || tokens.RefreshToken == "" {
		t.Fatalf("expected token pair, got %#v", tokens)
	}

	meReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	me, err := http.DefaultClient.Do(meReq)
	if err != nil {
		t.Fatal(err)
	}
	me.Body.Close()
	if me.StatusCode != http.StatusOK {
		t.Fatalf("expected /auth/me 200, got %d", me.StatusCode)
	}

	refreshed := postJSON(t, proxy.URL+"/auth/refresh", "", map[string]string{"refresh_token": tokens.RefreshToken})
	defer refreshed.Body.Close()
	if refreshed.StatusCode != http.StatusOK {
		t.Fatalf("expected refresh 200, got %d", refreshed.StatusCode)
	}
	var rotated struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(refreshed.Body).Decode(&rotated); err != nil {
		t.Fatal(err)
	}
	reuseOld := postJSON(t, proxy.URL+"/auth/refresh", "", map[string]string{"refresh_token": tokens.RefreshToken})
	reuseOld.Body.Close()
	if reuseOld.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old refresh token should be revoked after rotation, got %d", reuseOld.StatusCode)
	}
	logout := postJSON(t, proxy.URL+"/auth/logout", rotated.AccessToken, map[string]string{"refresh_token": rotated.RefreshToken})
	logout.Body.Close()
	if logout.StatusCode != http.StatusOK {
		t.Fatalf("logout failed: %d", logout.StatusCode)
	}
	afterLogout := postJSON(t, proxy.URL+"/auth/refresh", "", map[string]string{"refresh_token": rotated.RefreshToken})
	afterLogout.Body.Close()
	if afterLogout.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh after logout should fail, got %d", afterLogout.StatusCode)
	}
}

func TestAPIKeyScopesRevokeAndModelPolicy(t *testing.T) {
	var seenAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()
	db, proxy := newAuthTestServer(t, upstream.URL)
	defer proxy.Close()

	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var tokens struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	login.Body.Close()

	createKey := postJSON(t, proxy.URL+"/admin/api-keys", tokens.AccessToken, map[string]any{
		"name":           "dev-key",
		"scopes":         []string{"chat:completion", "models:read"},
		"allowed_models": []string{"gpt-4.1-mini"},
	})
	defer createKey.Body.Close()
	if createKey.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createKey.Body)
		t.Fatalf("api key create failed: %d %s", createKey.StatusCode, body)
	}
	var created struct {
		APIKey struct {
			ID string `json:"id"`
		} `json:"api_key"`
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(createKey.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Secret == "" || created.APIKey.ID == "" {
		t.Fatalf("expected secret once, got %#v", created)
	}
	rec, found, err := db.GetAPIKey(context.Background(), created.APIKey.ID)
	if err != nil || !found {
		t.Fatalf("stored key lookup failed found=%v err=%v", found, err)
	}
	if rec.KeyHash == created.Secret || rec.KeyHash == "" {
		t.Fatalf("api key plaintext must not be stored; hash=%q secret=%q", rec.KeyHash, created.Secret)
	}

	okResp := postJSON(t, proxy.URL+"/v1/chat/completions", created.Secret, chatBody("gpt-4.1-mini", false))
	okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("scoped key should allow chat, got %d", okResp.StatusCode)
	}
	if seenAuth != "Bearer secret" {
		t.Fatalf("upstream should receive provider key, not client key, got %q", seenAuth)
	}

	deniedModel := postJSON(t, proxy.URL+"/v1/chat/completions", created.Secret, chatBody("gpt-blocked", false))
	deniedModel.Body.Close()
	if deniedModel.StatusCode != http.StatusForbidden {
		t.Fatalf("model policy should deny blocked model, got %d", deniedModel.StatusCode)
	}

	revoke := postJSON(t, proxy.URL+"/admin/api-keys/"+created.APIKey.ID+"/revoke", tokens.AccessToken, map[string]string{})
	revoke.Body.Close()
	if revoke.StatusCode != http.StatusOK {
		t.Fatalf("revoke failed: %d", revoke.StatusCode)
	}
	afterRevoke := postJSON(t, proxy.URL+"/v1/chat/completions", created.Secret, chatBody("gpt-4.1-mini", false))
	afterRevoke.Body.Close()
	if afterRevoke.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked key should be denied, got %d", afterRevoke.StatusCode)
	}
	events, err := db.ListAuditEvents(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	seenCreated, seenRevoked, seenModelDenied := false, false, false
	for _, e := range events {
		switch e.EventType {
		case "api_key_created":
			seenCreated = true
		case "api_key_revoked":
			seenRevoked = true
		case "model_denied":
			seenModelDenied = true
		}
	}
	if !seenCreated || !seenRevoked || !seenModelDenied {
		t.Fatalf("expected auth audit events, got %#v", events)
	}
}

func TestAPIKeyWithoutRequiredScopeDenied(t *testing.T) {
	db, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()
	secret := "vc_sk_missing_scope"
	if err := db.UpsertAPIKey(context.Background(), store.APIKeyRecord{
		ID: "key_scope_missing", Name: "scope-missing", KeyHash: hashProxyKey(secret), Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	resp := postJSON(t, proxy.URL+"/v1/chat/completions", secret, chatBody("gpt-4.1-mini", false))
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("key without chat:completion scope should be denied, got %d", resp.StatusCode)
	}
	events, _ := db.ListAuditEvents(context.Background(), 10)
	found := false
	for _, e := range events {
		if e.EventType == "scope_denied" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected scope_denied audit event, got %#v", events)
	}
}
