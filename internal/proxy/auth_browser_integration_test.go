//go:build linux

package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"vibe-coders/internal/appui"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const browserAuthAccessTTL = 8 * time.Second

type browserAuthHarness struct {
	gateway          *httptest.Server
	idp              *browserOIDCFixture
	db               *store.SQLStore
	adminPassword    string
	readonlyPassword string
	childScratch     string
}

func browserFixtureConfig(idp *browserOIDCFixture) config.Config {
	cfg := testConfig(idp.server.URL+"/unused-upstream", "")
	cfg.Keycloak = config.KeycloakConfig{
		Enabled: true, IssuerURL: idp.server.URL, ClientID: idp.clientID, ClientSecret: idp.clientSecret,
		RedirectURI: idp.redirect, Scopes: []string{"openid", "profile", "email"}, DefaultRole: "viewer",
		RoleClaim: "realm_access.roles", GroupClaim: "groups", AllowLocalLogin: true,
		RoleMap: map[string]string{"browser-admin": "admin"},
	}
	cfg.Auth.Enabled = true
	cfg.Auth.AccessTokenTTL = browserAuthAccessTTL
	cfg.Auth.RefreshTokenTTL = 10 * time.Minute
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	cfg.Auth.ServiceKeyPrefix = "vc_sa_"
	return cfg
}

func newBrowserAuthHarness(t *testing.T) *browserAuthHarness {
	t.Helper()
	gateway := httptest.NewUnstartedServer(nil)
	t.Cleanup(func() {
		gateway.CloseClientConnections()
		gateway.Close()
	})
	callback := "http://" + gateway.Listener.Addr().String() + "/auth/keycloak/callback"
	idp := newBrowserOIDCFixture(t, callback)
	scratch := t.TempDir()
	childScratch := filepath.Join(scratch, "browser-tmp")
	if err := os.Mkdir(childScratch, 0o700); err != nil {
		t.Fatal("isolated browser temporary directory could not be created")
	}
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(scratch, "auth.db")})
	if err != nil {
		t.Fatal("isolated authentication database could not be opened")
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("isolated authentication schema could not be prepared")
	}
	h := &browserAuthHarness{gateway: gateway, idp: idp, db: db, adminPassword: browserFixtureSecret(t), readonlyPassword: browserFixtureSecret(t), childScratch: childScratch}
	if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: "browser-team", Name: "browser-team"}); err != nil {
		t.Fatal("synthetic authentication team could not be created")
	}
	for _, account := range []struct{ id, email, password, role string }{
		{"browser-local-admin", "admin-browser@example.invalid", h.adminPassword, "admin"},
		{"browser-local-readonly", "readonly-browser@example.invalid", h.readonlyPassword, "readonly_admin"},
	} {
		hash, err := bcrypt.GenerateFromPassword([]byte(account.password), bcrypt.DefaultCost)
		if err != nil {
			t.Fatal("synthetic account password could not be prepared")
		}
		if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: account.id, Email: account.email, PasswordHash: string(hash), Name: "브라우저 인증 테스트", Role: account.role, Status: "active"}); err != nil {
			t.Fatal("synthetic authentication account could not be created")
		}
		if err := db.UpsertMembership(t.Context(), store.UserTeamMembership{UserID: account.id, TeamID: "browser-team", Role: "member"}); err != nil {
			t.Fatal("synthetic team membership could not be created")
		}
	}
	for key, value := range map[string]string{
		appUIEnabledKey: "true", appUITelemetryEnabledKey: "false", appUILegacyFallbackKey: "true",
	} {
		encoded, _ := json.Marshal(value)
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: key, Category: "ui.app", ValueJSON: string(encoded), ValueType: "bool"}, "browser-fixture", "isolated fixture"); err != nil {
			t.Fatal("isolated UI setting could not be initialized")
		}
	}
	logger := store.NewAsyncLogger(db, 32, filepath.Join(scratch, "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		logger.Stop(ctx)
	})
	cfg := browserFixtureConfig(idp)
	cfg.Auth.JWTSecret = browserFixtureSecret(t)
	cfg.Secret.GatewaySecret = browserFixtureSecret(t)
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal("isolated gateway could not be initialized")
	}
	gateway.Config.Handler = server.Routes() // No test routes or authentication bypass.
	gateway.Config.ErrorLog = log.New(io.Discard, "", 0)
	gateway.Config.ReadHeaderTimeout = 3 * time.Second
	gateway.Config.ReadTimeout = 10 * time.Second
	gateway.Config.WriteTimeout = 15 * time.Second
	gateway.Start()
	// Stop HTTP traffic before closing the database and its managed workers.
	t.Cleanup(func() {
		gateway.CloseClientConnections()
		gateway.Close()
	})
	return h
}

// Build/stage web/dist into internal/appui/dist BEFORE compiling this test (or
// go test -c binary), then execute from the checkout or internal/proxy:
//
//	VIBE_AUTH_BROWSER_TEST=1 GOTOOLCHAIN=go1.26.8 go test ./internal/proxy \
//	  -run '^TestAuthBrowserIntegration$' -count=1 -timeout=6m
//
// Playwright must use workers=1/retries=0, APP_BASE_URL, and real HTTP APIs.
// Trace/HAR/video/storage-state output is forbidden: they contain credentials.
// This loopback fixture does NOT claim cross-origin HTTPS IdP logout coverage.
func TestAuthBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_AUTH_BROWSER_TEST") != "1" {
		t.Skip("opt-in real authentication browser integration")
	}
	index, err := fs.ReadFile(appui.EmbeddedFS(), "index.html")
	assets, assetsErr := fs.ReadDir(appui.EmbeddedFS(), "assets")
	if err != nil || assetsErr != nil || len(assets) == 0 || !bytes.Contains(index, []byte("/app/assets/")) {
		t.Fatal("build and stage the React assets before compiling the browser integration test")
	}
	webDir := browserAuthWebDirectory(t)
	playwrightCLI := filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js")
	if info, err := os.Stat(playwrightCLI); err != nil || info.IsDir() {
		t.Fatal("install the locked browser test dependencies before running the integration harness")
	}
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLog) })
	h := newBrowserAuthHarness(t)
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	// Invoke the already-installed CLI directly. Package-manager exec can
	// reinstall dependencies when a checkout crosses host/container platforms.
	cmd := exec.CommandContext(ctx, "node", playwrightCLI, "test", "--config", "playwright.auth.config.ts")
	cmd.Dir = webDir
	cmd.Env = h.childEnvironment()
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
	err = cmd.Run()
	if cmd.Process != nil {
		// Also clean up any orphaned browser descendants after an abnormal exit.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err != nil {
		if ctx.Err() != nil {
			t.Fatal("real authentication browser suite exceeded its bounded run budget")
		}
		if cmd.ProcessState != nil {
			t.Fatalf("real authentication browser suite failed (exit code %d); raw child output intentionally suppressed", cmd.ProcessState.ExitCode())
		}
		t.Fatal("real authentication browser runner could not be started")
	}
}

func browserAuthWebDirectory(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal("browser integration working directory unavailable")
	}
	for {
		candidate := filepath.Join(dir, "web")
		if info, err := os.Stat(filepath.Join(candidate, "playwright.auth.config.ts")); err == nil && !info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("web/playwright.auth.config.ts must exist in the checked-out browser integration workspace")
		}
		dir = parent
	}
}

func (h *browserAuthHarness) childEnvironment() []string {
	// Do not inherit operational credentials, auth settings, proxies, NODE_OPTIONS,
	// or application data paths. Only tooling/browser environment is forwarded.
	allowed := map[string]bool{
		"PATH": true, "HOME": true, "USER": true, "LOGNAME": true,
		"LANG": true, "LC_ALL": true, "TZ": true, "DISPLAY": true, "WAYLAND_DISPLAY": true, "XDG_RUNTIME_DIR": true,
		"XDG_CACHE_HOME": true, "XDG_CONFIG_HOME": true, "PNPM_HOME": true, "COREPACK_HOME": true, "PLAYWRIGHT_BROWSERS_PATH": true,
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if allowed[key] {
			env = append(env, entry)
		}
	}
	return append(env,
		// Chromium user-data-dir and other tool scratch stay inside t.TempDir,
		// including when a hard timeout prevents Playwright's normal cleanup.
		"TMPDIR="+h.childScratch, "TMP="+h.childScratch, "TEMP="+h.childScratch,
		"CI=1", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "COREPACK_ENABLE_NETWORK=0", "APP_BASE_URL="+h.gateway.URL,
		"VIBE_AUTH_IDP_ORIGIN="+h.idp.server.URL,
		"VIBE_AUTH_ADMIN_EMAIL=admin-browser@example.invalid", "VIBE_AUTH_ADMIN_PASSWORD="+h.adminPassword,
		"VIBE_AUTH_READONLY_EMAIL=readonly-browser@example.invalid", "VIBE_AUTH_READONLY_PASSWORD="+h.readonlyPassword,
		"VIBE_AUTH_SSO_EMAIL="+h.idp.email, "VIBE_AUTH_SSO_PASSWORD="+h.idp.password,
		"VIBE_AUTH_TEAM_ID=browser-team", "VIBE_AUTH_ACCESS_TTL_SECONDS="+strconv.Itoa(int(browserAuthAccessTTL.Seconds())),
	)
}

func browserAuthJSON(t *testing.T, client *http.Client, method, target, bearer string, body any, expected int) map[string]any {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal("synthetic request could not be encoded")
	}
	request, err := http.NewRequest(method, target, bytes.NewReader(data))
	if err != nil {
		t.Fatal("synthetic request could not be built")
	}
	request.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("isolated authentication HTTP request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != expected {
		t.Fatalf("isolated authentication response status=%d, want=%d; sensitive response omitted", response.StatusCode, expected)
	}
	var decoded map[string]any
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&decoded) != nil {
		t.Fatal("isolated authentication response was not valid JSON")
	}
	return decoded
}

func TestAuthBrowserFixtureLocalSessionAndPermissions(t *testing.T) {
	h := newBrowserAuthHarness(t)
	client := browserOIDCTestClient(t)
	login := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/login", "", map[string]string{
		"email": "admin-browser@example.invalid", "password": h.adminPassword,
	}, 200)
	access, _ := login["access_token"].(string)
	refresh, _ := login["refresh_token"].(string)
	if access == "" || refresh == "" || login["expires_in"] != browserAuthAccessTTL.Seconds() {
		t.Fatal("real authentication did not return the bounded session contract")
	}
	me := browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", access, nil, 200)
	user, ok := me["user"].(map[string]any)
	if !ok || user["role"] != "admin" || user["team_id"] != "browser-team" {
		t.Fatal("real local account/team provisioning did not match the fixture")
	}
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/admin/users", access, nil, 200)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/admin/teams", access, nil, 200)
	rotated := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/refresh", "", map[string]string{"refresh_token": refresh}, 200)
	newRefresh, _ := rotated["refresh_token"].(string)
	newAccess, _ := rotated["access_token"].(string)
	if newRefresh == "" || newRefresh == refresh || newAccess == "" {
		t.Fatal("real refresh did not rotate credentials")
	}
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/refresh", "", map[string]string{"refresh_token": refresh}, 401)
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/logout", newAccess, map[string]string{"refresh_token": newRefresh}, 200)
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/refresh", "", map[string]string{"refresh_token": newRefresh}, 401)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", newAccess, nil, 401)
	readonly := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/login", "", map[string]string{
		"email": "readonly-browser@example.invalid", "password": h.readonlyPassword,
	}, 200)
	readonlyAccess, _ := readonly["access_token"].(string)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/admin/users", readonlyAccess, nil, 200)
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/admin/teams", readonlyAccess, map[string]string{"name": "forbidden-team"}, 401)
}

func TestAuthBrowserFixtureRealSSORedirectAndExchange(t *testing.T) {
	h := newBrowserAuthHarness(t)
	client := browserOIDCTestClient(t)
	response, err := client.Get(h.gateway.URL + "/auth/keycloak/login?return_to=%2Fapp%2Faccess%2Fusers")
	if err != nil {
		t.Fatal("gateway SSO initiation failed")
	}
	response.Body.Close()
	authorization, err := response.Location()
	if err != nil || response.StatusCode != 302 || authorization.Host != strings.TrimPrefix(h.idp.server.URL, "http://") {
		t.Fatal("gateway did not redirect to the local OIDC issuer")
	}
	response, err = client.Get(authorization.String())
	if err != nil {
		t.Fatal("OIDC login page request failed")
	}
	page, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
	response.Body.Close()
	match := regexpBrowserRequestID.FindSubmatch(page)
	if response.StatusCode != 200 || len(match) != 2 {
		t.Fatal("OIDC login page missing its bound request")
	}
	response, err = client.PostForm(h.idp.server.URL+"/authorize", url.Values{"request_id": {string(match[1])}, "email": {h.idp.email}, "password": {h.idp.password}})
	if err != nil {
		t.Fatal("OIDC synthetic login failed")
	}
	response.Body.Close()
	callback, err := response.Location()
	if err != nil || response.StatusCode != 302 {
		t.Fatal("OIDC callback redirect missing")
	}
	response, err = client.Get(callback.String())
	if err != nil {
		t.Fatal("gateway OIDC callback failed")
	}
	response.Body.Close()
	landing, err := response.Location()
	if err != nil || response.StatusCode != 302 || landing.Path != "/app/access/users" {
		t.Fatal("SSO did not preserve the original console destination")
	}
	fragment, _ := url.ParseQuery(landing.Fragment)
	code := fragment.Get("kc_code")
	if code == "" || fragment.Get("kc_error") != "" {
		t.Fatal("gateway did not issue a browser-bound one-use exchange")
	}
	tokens := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/sso/exchange", "", map[string]string{"code": code}, 200)
	access, _ := tokens["access_token"].(string)
	refresh, _ := tokens["refresh_token"].(string)
	me := browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", access, nil, 200)
	user, ok := me["user"].(map[string]any)
	if !ok || user["role"] != "admin" || user["team_id"] != "browser-team" || user["email"] != h.idp.email {
		t.Fatal("SSO subject, role, or canonical team provisioning failed")
	}
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/sso/exchange", "", map[string]string{"code": code}, 401)
	logout := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/keycloak/logout", access, map[string]string{"refresh_token": refresh, "return_to": "/app/login"}, 200)
	if logout["end_session_url"] != "" {
		t.Fatal("HTTP fixture must not claim cross-origin HTTPS IdP logout coverage")
	}
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/refresh", "", map[string]string{"refresh_token": refresh}, 401)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", access, nil, 401)
}

func TestAuthBrowserFixtureChildEnvironmentIsIsolated(t *testing.T) {
	t.Setenv("AUTH_JWT_SECRET", "must-not-inherit")
	t.Setenv("OPENAI_API_KEY", "must-not-inherit")
	t.Setenv("NODE_OPTIONS", "--not-an-approved-option")
	t.Setenv("HTTPS_PROXY", "http://must-not-inherit.invalid")
	h := &browserAuthHarness{
		gateway:       &httptest.Server{URL: "http://127.0.0.1:32123"},
		idp:           &browserOIDCFixture{server: &httptest.Server{URL: "http://127.0.0.1:32124"}, email: "synthetic@example.invalid", password: "fixture-only"},
		adminPassword: "fixture-only", readonlyPassword: "fixture-only",
	}
	env := map[string]string{}
	for _, entry := range h.childEnvironment() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	for _, forbidden := range []string{"AUTH_JWT_SECRET", "OPENAI_API_KEY", "NODE_OPTIONS", "HTTPS_PROXY"} {
		if _, found := env[forbidden]; found {
			t.Fatal("child environment inherited an operational credential or process override")
		}
	}
	if env["APP_BASE_URL"] != h.gateway.URL || env["VIBE_AUTH_IDP_ORIGIN"] != h.idp.server.URL ||
		env["VIBE_AUTH_ACCESS_TTL_SECONDS"] != "8" || env["COREPACK_ENABLE_NETWORK"] != "0" ||
		env["VIBE_AUTH_ADMIN_PASSWORD"] != h.adminPassword {
		t.Fatal("child environment did not preserve the approved synthetic fixture contract")
	}
}

func TestAuthBrowserFixtureTemporaryFilesArePrivateAndIsolated(t *testing.T) {
	h := newBrowserAuthHarness(t)
	info, err := os.Stat(h.childScratch)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatal("browser temporary directory is not owner-only")
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, "/ambient-temp-must-not-be-inherited")
	}
	counts := map[string]int{}
	for _, entry := range h.childEnvironment() {
		key, value, _ := strings.Cut(entry, "=")
		switch key {
		case "TMPDIR", "TMP", "TEMP":
			counts[key]++
			if value != h.childScratch {
				t.Fatal("browser temporary environment escaped the owned scratch directory")
			}
		}
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		if counts[name] != 1 {
			t.Fatal("browser temporary environment was absent or inherited twice")
		}
	}
}
