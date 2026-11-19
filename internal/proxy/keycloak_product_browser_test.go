//go:build linux

package proxy

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/appui"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const productIssuer = "https://127.0.0.2:8443/realms/vibe-browser"

// Invoked only by scripts/test-keycloak-browser.py in a private, network=none
// namespace shared with the pinned Keycloak image. No production URL is accepted.
func TestKeycloakProductBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_KEYCLOAK_PRODUCT_TEST") != "1" {
		t.Skip("opt-in real Keycloak product integration")
	}
	if _, err := fs.ReadFile(appui.EmbeddedFS(), "index.html"); err != nil {
		t.Fatal("stage the production React assets before compiling this test")
	}
	var fixture struct {
		ClientSecret string `json:"client_secret"`
		Password     string `json:"password"`
	}
	data, err := os.ReadFile("/fixture/browser.json")
	if err != nil || json.Unmarshal(data, &fixture) != nil || len(fixture.ClientSecret) < 32 || len(fixture.Password) < 32 {
		t.Fatal("private product fixture is missing or invalid")
	}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	scratch := t.TempDir()
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(scratch, "product.db")})
	if err != nil {
		t.Fatal("isolated product database unavailable")
	}
	t.Cleanup(func() { _ = db.Close() })
	if db.Migrate(t.Context()) != nil {
		t.Fatal("isolated product database migration failed")
	}
	if db.CreateAuthUser(t.Context(), store.AuthUser{ID: "existing-product-user", Email: "existing@example.invalid", Name: "기존 사용자", Role: "admin", Status: "active", PasswordHash: "disabled-local-password"}) != nil {
		t.Fatal("existing synthetic user could not be created")
	}
	for key, value := range map[string]string{appUIEnabledKey: "true", appUITelemetryEnabledKey: "false", appUILegacyFallbackKey: "true"} {
		encoded, _ := json.Marshal(value)
		if db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: key, Category: "ui.app", ValueJSON: string(encoded), ValueType: "bool"}, "product-fixture", "isolated fixture") != nil {
			t.Fatal("synthetic UI settings unavailable")
		}
	}
	cfg := testConfig("http://127.0.0.1:9", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = browserFixtureSecret(t)
	cfg.Secret.GatewaySecret = browserFixtureSecret(t)
	cfg.Auth.AccessTokenTTL = time.Minute
	cfg.Auth.RefreshTokenTTL = 10 * time.Minute
	cfg.Keycloak = config.KeycloakConfig{
		Enabled: true, AutoLogin: true, IssuerURL: productIssuer,
		ClientID: "vibe-browser", ClientSecret: fixture.ClientSecret,
		RedirectURI: "https://127.0.0.1:4187/auth/keycloak/callback",
		Scopes:      []string{"openid", "profile", "email"}, DefaultRole: "viewer",
		RoleClaim: "realm_access.roles", GroupClaim: "groups", AllowLocalLogin: true,
	}
	providerFixture := store.ProviderConfig{Name: "SSO +%2F?&# 공급자", BaseURL: "http://127.0.0.1:9", TimeoutMS: 1000, Enabled: false, Priority: 100}
	if err := db.UpsertProvider(t.Context(), providerFixture); err != nil {
		t.Fatal("synthetic provider unavailable")
	}
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: "SSO 요청 +%2F?&#", Model: "public-model", ClientIP: "2001:db8::7",
		Method: "POST", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal("synthetic request unavailable")
	}
	providersBefore, err := db.ListProviderConfigs(t.Context())
	if err != nil {
		t.Fatal("provider baseline unavailable")
	}
	providerBytesBefore, err := json.Marshal(providersBefore)
	if err != nil {
		t.Fatal("provider baseline invalid")
	}
	logger := store.NewAsyncLogger(db, 32, filepath.Join(scratch, "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		logger.Stop(ctx)
	})
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal("isolated product gateway unavailable")
	}
	gateway := httptest.NewUnstartedServer(server.Routes())
	_ = gateway.Listener.Close()
	gateway.Listener, err = net.Listen("tcp", "127.0.0.1:4187")
	if err != nil {
		t.Fatal("isolated gateway port unavailable")
	}
	gateway.Config.ErrorLog = log.New(io.Discard, "", 0)
	gateway.StartTLS()
	t.Cleanup(gateway.Close)
	web := browserAuthWebDirectory(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(web, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", "playwright.keycloak.config.ts")
	command.Dir = web
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + scratch, "TMPDIR=" + scratch, "APP_BASE_URL=" + gateway.URL, "VIBE_KEYCLOAK_PASSWORD=" + fixture.Password, "PLAYWRIGHT_BROWSERS_PATH=" + os.Getenv("PLAYWRIGHT_BROWSERS_PATH")}
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if command.Run() != nil {
		t.Fatal("Keycloak product browser checks failed; see the numeric-only summary")
	}
	summaryBytes, err := os.ReadFile(filepath.Join(web, "test-results", "keycloak-live-summary.json"))
	if err != nil {
		t.Fatal("Keycloak product summary missing")
	}
	var summary struct {
		Status string `json:"status"`
		Tests  []struct {
			Scenario string `json:"scenario"`
			Status   string `json:"status"`
		} `json:"tests"`
	}
	if json.Unmarshal(summaryBytes, &summary) != nil || summary.Status != "passed" || len(summary.Tests) != 7 {
		t.Fatal("Keycloak product summary incomplete")
	}
	seen := map[string]bool{}
	for _, test := range summary.Tests {
		if test.Status != "passed" || seen[test.Scenario] || (test.Scenario != "KEYCLOAK-LIVE-001" && test.Scenario != "KEYCLOAK-LIVE-002" && test.Scenario != "KEYCLOAK-LIVE-003" && test.Scenario != "KEYCLOAK-LIVE-004" && test.Scenario != "KEYCLOAK-LIVE-005" && test.Scenario != "KEYCLOAK-LIVE-006" && test.Scenario != "KEYCLOAK-LIVE-007") {
			t.Fatal("Keycloak product scenario failed or duplicated")
		}
		seen[test.Scenario] = true
	}
	for _, expected := range []struct{ email, role string }{{"existing@example.invalid", "admin"}, {"new@example.invalid", "admin"}, {"reader@example.invalid", "readonly_admin"}} {
		user, found, err := db.AuthUserByEmail(t.Context(), expected.email)
		if err != nil || !found || user.Role != expected.role || user.Status != "active" {
			t.Fatal("real IdP provisioning did not persist the expected account and role")
		}
		if expected.email == "existing@example.invalid" && (user.ID != "existing-product-user" || user.PasswordHash != "disabled-local-password") {
			t.Fatal("email collision replaced the protected local account")
		}
	}
	users, err := db.ListAuthUsers(t.Context())
	if err != nil || len(users) != 4 {
		t.Fatal("real IdP provisioning duplicated or lost a local/SSO account")
	}
	conflictAccounts := 0
	for _, user := range users {
		if strings.HasSuffix(user.Email, "@sso.local") && user.Role == "admin" && user.PasswordHash == "" && user.ID != "existing-product-user" {
			conflictAccounts++
		}
	}
	if conflictAccounts != 1 {
		t.Fatal("email collision did not produce exactly one separate SSO-only account")
	}
	providersAfter, err := db.ListProviderConfigs(t.Context())
	if err != nil {
		t.Fatal("provider verification unavailable")
	}
	providerBytesAfter, err := json.Marshal(providersAfter)
	if err != nil || string(providerBytesBefore) != string(providerBytesAfter) {
		t.Fatal("read-only SSO handoff changed provider data")
	}
	t.Log("seven real Keycloak HTTPS browser scenarios, persisted provisioning and provider data preservation checks passed")
}
