package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
