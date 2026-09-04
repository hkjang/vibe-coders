package proxy

import (
	"context"
	"encoding/json"
	"fmt"
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
		AuthEnabled        bool     `json:"auth_enabled"`
		CredentialPrefixes []string `json:"credential_prefixes"`
		User               struct {
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
	if strings.Join(meOut.CredentialPrefixes, ",") != "vc_sk_,vc_sa_" {
		t.Fatalf("unexpected /auth/me credential prefixes: %#v", meOut.CredentialPrefixes)
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

// TestHardDeleteKeyTeamChangeAndScopeEdit covers the three management additions:
// super_admin-only hard delete, account team change, and API key scope editing.
func TestHardDeleteKeyTeamChangeAndScopeEdit(t *testing.T) {
	db, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()
	ctx := context.Background()

	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var rootTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(login.Body).Decode(&rootTok)
	login.Body.Close()
	authedReq := func(method, path, body string) *http.Response {
		req, _ := http.NewRequest(method, proxy.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+rootTok.AccessToken)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	// --- ① scope edit: create a key, then PATCH scopes ---
	created := postJSON(t, proxy.URL+"/admin/api-keys", rootTok.AccessToken, map[string]any{"name": "scoped-key"})
	var keyOut struct {
		APIKey struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	_ = json.NewDecoder(created.Body).Decode(&keyOut)
	created.Body.Close()
	keyID := keyOut.APIKey.ID
	pr := authedReq(http.MethodPatch, "/admin/api-keys/"+keyID, `{"scopes":["models:read"]}`)
	pr.Body.Close()
	if pr.StatusCode != http.StatusOK {
		t.Fatalf("scope patch failed: %d", pr.StatusCode)
	}
	rec, found, _ := db.GetAPIKey(ctx, keyID)
	if !found || len(rec.Scopes) != 1 || rec.Scopes[0] != "models:read" {
		t.Fatalf("scopes not updated: %+v", rec.Scopes)
	}

	// --- ② hard delete: admin role denied, super_admin allowed ---
	cu := postJSON(t, proxy.URL+"/admin/users", rootTok.AccessToken, map[string]string{"email": "adm@example.com", "password": "pw-adm", "role": "admin"})
	cu.Body.Close()
	admLogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "adm@example.com", "password": "pw-adm"})
	var admTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(admLogin.Body).Decode(&admTok)
	admLogin.Body.Close()
	denyReq, _ := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/api-keys/"+keyID+"?hard=1", nil)
	denyReq.Header.Set("Authorization", "Bearer "+admTok.AccessToken)
	denyRes, err := http.DefaultClient.Do(denyReq)
	if err != nil {
		t.Fatal(err)
	}
	denyRes.Body.Close()
	if denyRes.StatusCode != http.StatusForbidden {
		t.Fatalf("admin role should be denied hard delete, got %d", denyRes.StatusCode)
	}
	delRes := authedReq(http.MethodDelete, "/admin/api-keys/"+keyID+"?hard=1", "")
	delRes.Body.Close()
	if delRes.StatusCode != http.StatusOK {
		t.Fatalf("super_admin hard delete failed: %d", delRes.StatusCode)
	}
	if _, found, _ := db.GetAPIKey(ctx, keyID); found {
		t.Fatal("key row should be gone after hard delete")
	}

	// --- ③ team change on a login account ---
	tm := postJSON(t, proxy.URL+"/admin/teams", rootTok.AccessToken, map[string]string{"name": "platform"})
	var teamOut struct {
		Team struct {
			ID string `json:"id"`
		} `json:"team"`
	}
	_ = json.NewDecoder(tm.Body).Decode(&teamOut)
	tm.Body.Close()
	cu2 := postJSON(t, proxy.URL+"/admin/users", rootTok.AccessToken, map[string]string{"email": "member@example.com", "password": "pw-m", "role": "developer"})
	var memberOut struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(cu2.Body).Decode(&memberOut)
	cu2.Body.Close()
	tp := authedReq(http.MethodPatch, "/admin/users/"+memberOut.User.ID, `{"team_id":"`+teamOut.Team.ID+`"}`)
	tp.Body.Close()
	if tp.StatusCode != http.StatusOK {
		t.Fatalf("team patch failed: %d", tp.StatusCode)
	}
	gotTeam, _ := db.PrimaryTeamForUser(ctx, memberOut.User.ID)
	if gotTeam != teamOut.Team.ID {
		t.Fatalf("team not applied: %q want %q", gotTeam, teamOut.Team.ID)
	}
	// clear team
	tc := authedReq(http.MethodPatch, "/admin/users/"+memberOut.User.ID, `{"team_id":""}`)
	tc.Body.Close()
	gotTeam, _ = db.PrimaryTeamForUser(ctx, memberOut.User.ID)
	if gotTeam != "" {
		t.Fatalf("team should be cleared, got %q", gotTeam)
	}
	// unknown team rejected
	bad := authedReq(http.MethodPatch, "/admin/users/"+memberOut.User.ID, `{"team_id":"team_nope"}`)
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown team should be 400, got %d", bad.StatusCode)
	}
}

func TestTeamAdminIsolationAndRoleEscalationGuards(t *testing.T) {
	db, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()

	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "root@example.com", "password": "correct-password"})
	var rootTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(login.Body).Decode(&rootTok)
	login.Body.Close()

	alpha := postJSON(t, proxy.URL+"/admin/teams", rootTok.AccessToken, map[string]string{"id": "team_alpha", "name": "Alpha"})
	alpha.Body.Close()
	beta := postJSON(t, proxy.URL+"/admin/teams", rootTok.AccessToken, map[string]string{"id": "team_beta", "name": "Beta"})
	beta.Body.Close()

	teamAdmin := postJSON(t, proxy.URL+"/admin/users", rootTok.AccessToken, map[string]string{
		"email": "team-admin@example.com", "password": "team-admin-password", "role": "team_admin", "team_id": "team_alpha",
	})
	teamAdmin.Body.Close()
	if teamAdmin.StatusCode != http.StatusCreated {
		t.Fatalf("super_admin should create team_admin, got %d", teamAdmin.StatusCode)
	}
	teamLogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{"email": "team-admin@example.com", "password": "team-admin-password"})
	var teamTok struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(teamLogin.Body).Decode(&teamTok)
	teamLogin.Body.Close()

	crossTeamUser := postJSON(t, proxy.URL+"/admin/users", teamTok.AccessToken, map[string]string{
		"email": "beta-dev@example.com", "password": "pw-beta", "role": "developer", "team_id": "team_beta",
	})
	crossTeamUser.Body.Close()
	if crossTeamUser.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not create users in another team, got %d", crossTeamUser.StatusCode)
	}
	escalatedUser := postJSON(t, proxy.URL+"/admin/users", teamTok.AccessToken, map[string]string{
		"email": "bad-admin@example.com", "password": "pw-bad", "role": "admin", "team_id": "team_alpha",
	})
	escalatedUser.Body.Close()
	if escalatedUser.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not assign admin role, got %d", escalatedUser.StatusCode)
	}
	ownTeamUser := postJSON(t, proxy.URL+"/admin/users", teamTok.AccessToken, map[string]string{
		"email": "alpha-dev@example.com", "password": "pw-alpha", "role": "developer", "team_id": "team_alpha",
	})
	ownTeamUser.Body.Close()
	if ownTeamUser.StatusCode != http.StatusCreated {
		t.Fatalf("team_admin should create own-team developer, got %d", ownTeamUser.StatusCode)
	}
	teamsReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/teams", nil)
	teamsReq.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	teamsResp, err := http.DefaultClient.Do(teamsReq)
	if err != nil {
		t.Fatal(err)
	}
	var teamsOut struct {
		AuthTeams []store.AuthTeam `json:"auth_teams"`
	}
	_ = json.NewDecoder(teamsResp.Body).Decode(&teamsOut)
	teamsResp.Body.Close()
	if teamsResp.StatusCode != http.StatusOK || len(teamsOut.AuthTeams) != 1 || teamsOut.AuthTeams[0].ID != "team_alpha" {
		t.Fatalf("team_admin should only list own auth team, status=%d teams=%+v", teamsResp.StatusCode, teamsOut.AuthTeams)
	}
	betaDetailReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/teams/team_beta", nil)
	betaDetailReq.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	betaDetailResp, err := http.DefaultClient.Do(betaDetailReq)
	if err != nil {
		t.Fatal(err)
	}
	betaDetailResp.Body.Close()
	if betaDetailResp.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not access other-team detail, got %d", betaDetailResp.StatusCode)
	}

	alphaKey := postJSON(t, proxy.URL+"/admin/api-keys", rootTok.AccessToken, map[string]any{"name": "alpha-key", "team": "team_alpha"})
	var alphaKeyOut struct {
		APIKey struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	_ = json.NewDecoder(alphaKey.Body).Decode(&alphaKeyOut)
	alphaKey.Body.Close()
	betaKey := postJSON(t, proxy.URL+"/admin/api-keys", rootTok.AccessToken, map[string]any{"name": "beta-key", "team": "team_beta"})
	var betaKeyOut struct {
		APIKey struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	_ = json.NewDecoder(betaKey.Body).Decode(&betaKeyOut)
	betaKey.Body.Close()

	listReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/api-keys", nil)
	listReq.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	listResp, err := http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		APIKeys []store.APIKeyPublic `json:"api_keys"`
	}
	_ = json.NewDecoder(listResp.Body).Decode(&listed)
	listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK || len(listed.APIKeys) != 1 || listed.APIKeys[0].Team != "team_alpha" {
		t.Fatalf("team_admin should only list own-team keys, status=%d keys=%+v", listResp.StatusCode, listed.APIKeys)
	}

	overScoped := postJSON(t, proxy.URL+"/admin/api-keys", teamTok.AccessToken, map[string]any{
		"name": "bad-scope", "scopes": []string{"chat:completion", "admin:write"},
	})
	overScoped.Body.Close()
	if overScoped.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not assign admin:write scope, got %d", overScoped.StatusCode)
	}
	invalidScope := postJSON(t, proxy.URL+"/admin/api-keys", teamTok.AccessToken, map[string]any{
		"name": "bad-scope-name", "scopes": []string{"chat:completion", "not:a_scope"},
	})
	invalidScope.Body.Close()
	if invalidScope.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid scope should be rejected, got %d", invalidScope.StatusCode)
	}
	ownKey := postJSON(t, proxy.URL+"/admin/api-keys", teamTok.AccessToken, map[string]any{
		"name": "team-owned", "team": "team_beta", "scopes": []string{"chat:completion", "models:read"},
	})
	var ownKeyOut struct {
		APIKey struct {
			ID   string `json:"id"`
			Team string `json:"team"`
		} `json:"api_key"`
	}
	_ = json.NewDecoder(ownKey.Body).Decode(&ownKeyOut)
	ownKey.Body.Close()
	if ownKey.StatusCode != http.StatusCreated || ownKeyOut.APIKey.Team != "team_alpha" {
		t.Fatalf("team_admin key should be forced to own team, status=%d out=%+v", ownKey.StatusCode, ownKeyOut)
	}
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "padded-alpha-key", Name: "malformed legacy key", KeyHash: "padded-alpha-key-hash",
		Team: " team_alpha ", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}

	createdAt := time.Now().UTC().Add(-time.Minute)
	for _, fixture := range []struct {
		id       string
		apiKeyID string
		ip       string
		model    string
		language string
		tag      string
		session  string
	}{
		{id: "req-alpha-trace", apiKeyID: alphaKeyOut.APIKey.ID, ip: "198.51.100.10", model: "alpha-model", language: "ko", tag: "alpha-tag", session: "scope-session-shared"},
		{id: "req-beta-trace", apiKeyID: betaKeyOut.APIKey.ID, ip: "198.51.100.10", model: "beta-model", language: "en", tag: "beta-tag", session: "scope-session-shared"},
		{id: "req-beta-only-trace", apiKeyID: betaKeyOut.APIKey.ID, ip: "198.51.100.20", model: "beta-only-model", language: "fr", tag: "beta-only-tag", session: "scope-session-beta-only"},
		{id: "req-padded-alpha-trace", apiKeyID: "padded-alpha-key", ip: "198.51.100.30", model: "padded-model", language: "de", tag: "padded-tag", session: "scope-session-padded"},
	} {
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{
				ID: fixture.id, TraceID: "trace-shared", APIKeyID: fixture.apiKeyID,
				Method: http.MethodPost, Endpoint: "/v1/chat/completions", Model: fixture.model, Provider: "scope-provider", ClientIP: fixture.ip,
				SessionID:  fixture.session,
				StatusCode: http.StatusOK, CreatedAt: createdAt,
			},
			Prompts: []store.PromptLog{{
				ID: "prompt-" + fixture.id, RequestID: fixture.id, Role: "user",
				ContentText: fixture.tag + "-private", RedactedText: fixture.tag + "-safe", CreatedAt: createdAt,
			}},
			Languages: []store.LanguageStat{{
				ID: "language-" + fixture.id, RequestID: fixture.id, Language: fixture.language,
				Confidence: 1, Evidence: fixture.language, CreatedAt: createdAt,
			}},
			CodeVerify: &store.CodeVerifyLog{
				ID: "code-" + fixture.id, RequestID: fixture.id, TraceID: "trace-shared",
				HasCode: true, Risk: "low", CreatedAt: createdAt,
			},
			Tools: []store.ToolInvocation{{
				ID: "tool-" + fixture.id, RequestID: fixture.id, TraceID: "trace-shared", APIKeyID: fixture.apiKeyID,
				ServerLabel: "scope-mcp", ToolName: "scope-read", Source: "call", IsMCP: true, CreatedAt: createdAt,
			}},
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.UpsertRequestNote(t.Context(), store.RequestNote{
			RequestID: fixture.id, Tags: []string{fixture.tag}, Note: fixture.tag, CreatedBy: "scope-test", UpdatedAt: createdAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.InsertText2SQLSpans(t.Context(), []store.Text2SQLSpan{
		{ID: "span-alpha-scope", RequestID: "req-alpha-trace", TraceID: "trace-shared", Stage: "validate", Status: "ok", Model: "alpha-model", Detail: "alpha-owner@example.com", CreatedAt: createdAt},
		{ID: "span-beta-scope", RequestID: "req-beta-trace", TraceID: "trace-shared", Stage: "validate", Status: "ok", Model: "beta-model", Detail: "beta-owner@example.com", CreatedAt: createdAt},
	}); err != nil {
		t.Fatal(err)
	}
	for _, text2SQLLog := range []store.Text2SQLQueryLog{
		{ID: "text2sql-alpha-scope", RequestID: "req-alpha-trace", APIKeyID: alphaKeyOut.APIKey.ID, Team: "team_alpha", VirtualModel: "vibe/text2sql-preview", UpstreamModel: "alpha-model", Mode: "preview", Question: "alpha question private", GeneratedSQL: "SELECT alpha_private", Valid: true, CostKRW: 1, CreatedAt: createdAt},
		{ID: "text2sql-beta-scope", RequestID: "req-beta-trace", APIKeyID: betaKeyOut.APIKey.ID, Team: "team_beta", VirtualModel: "vibe/text2sql-preview", UpstreamModel: "beta-model", Mode: "preview", Question: "beta question private", GeneratedSQL: "SELECT beta_private", Error: "beta error private", FailureCategory: "beta-private", CostKRW: 2, CreatedAt: createdAt},
	} {
		if err := db.InsertText2SQLLog(t.Context(), text2SQLLog); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 5; index++ {
		for _, fixture := range []struct {
			id, requestID, apiKeyID, team, model, question, sql string
			cost                                                float64
		}{
			{id: fmt.Sprintf("text2sql-alpha-risk-%d", index), requestID: "req-alpha-trace", apiKeyID: alphaKeyOut.APIKey.ID, team: "team_alpha", model: "alpha-model", question: "alpha question private", sql: "SELECT alpha_private", cost: 0},
			{id: fmt.Sprintf("text2sql-beta-risk-%d", index), requestID: "req-beta-trace", apiKeyID: betaKeyOut.APIKey.ID, team: "team_beta", model: "beta-model", question: "beta question private", sql: "SELECT beta_private", cost: 0},
		} {
			if err := db.InsertText2SQLLog(t.Context(), store.Text2SQLQueryLog{
				ID: fixture.id, RequestID: fixture.requestID, APIKeyID: fixture.apiKeyID, Team: fixture.team,
				VirtualModel: "vibe/text2sql-preview", UpstreamModel: fixture.model, Mode: "preview",
				Question: fixture.question, GeneratedSQL: fixture.sql, Valid: true, RejectReason: fixture.team + " reject private",
				FailureCategory: "permission_denied", ExplainRisk: 80, CostKRW: fixture.cost, CreatedAt: createdAt.Add(time.Duration(index+1) * time.Second),
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, schema := range []store.Text2SQLSchema{
		{Team: "", Name: "schema-global-scope", Dialect: "postgres", SchemaText: "global schema private", AllowedTables: []string{"global_private"}, Enabled: true},
		{Team: "team_alpha", Name: "schema-alpha-scope", Dialect: "postgres", SchemaText: "alpha schema private", AllowedTables: []string{"alpha_private"}, Enabled: true},
		{Team: "team_beta", Name: "schema-beta-scope", Dialect: "postgres", SchemaText: "beta schema private", AllowedTables: []string{"beta_private"}, Enabled: true},
		{Team: " team_alpha ", Name: "schema-malformed-scope", Dialect: "postgres", SchemaText: "malformed schema private", AllowedTables: []string{"malformed_private"}, Enabled: true},
	} {
		if err := db.UpsertText2SQLSchema(t.Context(), schema); err != nil {
			t.Fatal(err)
		}
	}
	const text2SQLProfileCredential = "vc_sk_abcdefghijklmnopqrstuvwxyzABCDEF"
	if err := db.UpsertText2SQLProfile(t.Context(), store.Text2SQLProfile{
		VirtualModel: "vibe/text2sql-team-scope", Mode: "preview", UpstreamModel: text2SQLProfileCredential,
		SummaryModel: text2SQLProfileCredential, SchemaName: "schema-alpha-scope", ExecConnectionID: text2SQLProfileCredential, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	for _, event := range []store.PolicyDecisionEvent{
		{ID: "policy-alpha-scope", RequestID: "req-alpha-trace", APIKeyID: text2SQLProfileCredential, UserID: "alpha-owner@example.com", TeamID: "team_alpha", Decision: "allow", Reason: text2SQLProfileCredential, CreatedAt: createdAt},
		{ID: "policy-beta-scope", RequestID: "req-beta-trace", APIKeyID: text2SQLProfileCredential, UserID: "beta-owner@example.com", TeamID: "team_beta", Decision: "allow", Reason: "beta policy private", CreatedAt: createdAt},
	} {
		if err := db.InsertPolicyDecisionEvent(t.Context(), event); err != nil {
			t.Fatal(err)
		}
	}
	for _, approval := range []store.Approval{
		{ID: "approval-alpha-scope", RequestID: "req-alpha-trace", APIKeyID: text2SQLProfileCredential, UserID: "alpha-owner@example.com", TeamID: "team_alpha", SubjectType: "request", SubjectID: text2SQLProfileCredential, Status: "pending", Reason: "alpha approval private", Payload: text2SQLProfileCredential, ExpiresAt: createdAt.Add(2 * time.Hour), CreatedAt: createdAt},
		{ID: "approval-beta-scope", RequestID: "req-beta-trace", APIKeyID: text2SQLProfileCredential, UserID: "beta-owner@example.com", TeamID: "team_beta", SubjectType: "request", SubjectID: text2SQLProfileCredential, Status: "pending", Reason: "beta approval private", Payload: text2SQLProfileCredential, ExpiresAt: createdAt.Add(2 * time.Hour), CreatedAt: createdAt},
	} {
		if err := db.InsertApproval(t.Context(), approval); err != nil {
			t.Fatal(err)
		}
	}
	for _, event := range []store.SecretEvent{
		{ID: "secret-alpha-scope", RequestID: "req-alpha-trace", APIKeyID: text2SQLProfileCredential, UserID: "alpha-owner@example.com", TeamID: "team_alpha", SecretType: "api_key", Action: "mask", Location: text2SQLProfileCredential, MatchedHash: text2SQLProfileCredential, CreatedAt: createdAt},
		{ID: "secret-beta-scope", RequestID: "req-beta-trace", APIKeyID: text2SQLProfileCredential, UserID: "beta-owner@example.com", TeamID: "team_beta", SecretType: "api_key", Action: "mask", Location: "beta secret private", MatchedHash: text2SQLProfileCredential, CreatedAt: createdAt},
	} {
		if err := db.InsertSecretEvent(t.Context(), event); err != nil {
			t.Fatal(err)
		}
	}
	for _, bundle := range []store.Text2SQLReplayBundle{
		{ID: "replay-alpha-scope", RequestID: "req-alpha-trace", SystemPrompt: "alpha replay private", GeneratedSQL: "SELECT alpha_private"},
		{ID: "replay-beta-scope", RequestID: "req-beta-trace", SystemPrompt: "beta replay private", GeneratedSQL: "SELECT beta_private"},
	} {
		if err := db.PutText2SQLReplayBundle(t.Context(), bundle); err != nil {
			t.Fatal(err)
		}
	}
	getWithToken := func(token, path string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, proxy.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	teamGet := func(path string) (int, []byte) { return getWithToken(teamTok.AccessToken, path) }
	rootGet := func(path string) (int, []byte) { return getWithToken(rootTok.AccessToken, path) }

	requestsStatus, requestsBody := teamGet("/admin/requests?limit=20")
	if requestsStatus != http.StatusOK || !strings.Contains(string(requestsBody), "req-alpha-trace") {
		t.Fatalf("team_admin request list lost own-team row: status=%d body=%s", requestsStatus, requestsBody)
	}
	for _, denied := range []string{"req-beta-trace", "req-beta-only-trace", "req-padded-alpha-trace"} {
		if strings.Contains(string(requestsBody), denied) {
			t.Fatalf("team_admin request list exposed %q: %s", denied, requestsBody)
		}
	}
	waterfallStatus, waterfallBody := teamGet("/admin/mcp/requests/req-alpha-trace/waterfall")
	if waterfallStatus != http.StatusOK || !strings.Contains(string(waterfallBody), "req-alpha-trace") {
		t.Fatalf("team_admin MCP waterfall lost own request: status=%d body=%s", waterfallStatus, waterfallBody)
	}
	if status, body := teamGet("/admin/mcp/requests/req-beta-trace/waterfall"); status != http.StatusForbidden {
		t.Fatalf("team_admin could read another team's MCP waterfall: status=%d body=%s", status, body)
	}
	spanStatus, spanBody := teamGet("/admin/text2sql/spans?request_id=req-alpha-trace")
	if spanStatus != http.StatusOK || !strings.Contains(string(spanBody), "span-alpha-scope") || strings.Contains(string(spanBody), "alpha-owner@example.com") {
		t.Fatalf("team_admin own Text2SQL spans were missing or unmasked: status=%d body=%s", spanStatus, spanBody)
	}
	if status, body := teamGet("/admin/text2sql/spans?request_id=req-beta-trace"); status != http.StatusForbidden {
		t.Fatalf("team_admin could read another team's Text2SQL spans: status=%d body=%s", status, body)
	}
	if status, body := teamGet("/admin/text2sql/replay?request_id=req-alpha-trace"); status != http.StatusForbidden || strings.Contains(string(body), "alpha replay private") {
		t.Fatalf("team_admin could read a raw Text2SQL replay: status=%d body=%s", status, body)
	}
	text2SQLStatus, text2SQLBody := teamGet("/admin/text2sql?window=7d")
	if text2SQLStatus != http.StatusOK || !strings.Contains(string(text2SQLBody), "text2sql-alpha-scope") ||
		!strings.Contains(string(text2SQLBody), text2SQLSensitiveContentOmitted) {
		t.Fatalf("team_admin Text2SQL overview lost safe own-team metadata: status=%d body=%s", text2SQLStatus, text2SQLBody)
	}
	for _, denied := range []string{
		"text2sql-beta-scope", "alpha question private", "SELECT alpha_private", "beta question private", "SELECT beta_private", "beta error private",
		"schema-beta-scope", "schema-malformed-scope", "alpha schema private", "global schema private", "beta schema private", "malformed schema private",
		"alpha_private", "global_private", "beta_private", "malformed_private", text2SQLProfileCredential,
	} {
		if strings.Contains(string(text2SQLBody), denied) {
			t.Fatalf("team_admin Text2SQL overview exposed %q: %s", denied, text2SQLBody)
		}
	}
	for _, expected := range []string{"schema-alpha-scope", "schema-global-scope", text2SQLSensitiveContentOmitted} {
		if !strings.Contains(string(text2SQLBody), expected) {
			t.Fatalf("team_admin Text2SQL overview lost safe schema marker %q: %s", expected, text2SQLBody)
		}
	}
	var text2SQLPayload struct {
		Stats store.Text2SQLStats `json:"stats"`
	}
	if err := json.Unmarshal(text2SQLBody, &text2SQLPayload); err != nil {
		t.Fatal(err)
	}
	if text2SQLPayload.Stats.Total != 6 || text2SQLPayload.Stats.CostKRW != 1 {
		t.Fatalf("team_admin Text2SQL statistics escaped team scope: %+v", text2SQLPayload.Stats)
	}
	for _, check := range []struct {
		path         string
		want         []string
		mustNotExist []string
	}{
		{path: "/admin/text2sql/risk-queue?window=7d", want: []string{"text2sql-alpha-risk-0", text2SQLSensitiveContentOmitted}, mustNotExist: []string{"text2sql-beta-risk-0", "alpha question private", "SELECT alpha_private", "beta question private"}},
		{path: "/admin/text2sql/miners?window=7d&min_count=2", want: []string{"alpha", text2SQLSensitiveContentOmitted}, mustNotExist: []string{"beta", "alpha question private", "SELECT alpha_private"}},
		{path: "/admin/text2sql/prompt-dna?window=7d&min_count=2", want: []string{"\"count\":6", text2SQLSensitiveContentOmitted}, mustNotExist: []string{"alpha question private", "beta question private", "\"count\":12"}},
		{path: "/admin/text2sql/anomalies?window=7d", want: []string{alphaKeyOut.APIKey.ID, text2SQLSensitiveContentOmitted}, mustNotExist: []string{betaKeyOut.APIKey.ID, "alpha question private", "beta question private"}},
	} {
		status, body := teamGet(check.path)
		if status != http.StatusOK {
			t.Fatalf("team_admin safe Text2SQL endpoint failed for %s: status=%d body=%s", check.path, status, body)
		}
		for _, expected := range check.want {
			if !strings.Contains(string(body), expected) {
				t.Fatalf("team_admin safe Text2SQL endpoint %s lost %q: %s", check.path, expected, body)
			}
		}
		for _, denied := range check.mustNotExist {
			if strings.Contains(string(body), denied) {
				t.Fatalf("team_admin safe Text2SQL endpoint %s exposed %q: %s", check.path, denied, body)
			}
		}
	}
	for _, path := range []string{
		"/admin/text2sql/tables?schema=schema-alpha-scope", "/admin/text2sql/reports", "/admin/text2sql/schema-impact?schema=schema-alpha-scope",
		"/admin/text2sql/glossary", "/admin/text2sql/permissions", "/admin/text2sql/connections", "/admin/text2sql/registry/export",
		"/admin/text2sql/profiles", "/admin/text2sql/golden", "/admin/text2sql/schemas",
		"/admin/routing/domain-decisions", "/admin/routing/domain-examples", "/admin/routing/domain-review",
		"/admin/chat-test/multi-run/runs", "/admin/chat-test/multi-run/runs/nonexistent",
	} {
		if status, body := teamGet(path); status != http.StatusForbidden || strings.Contains(string(body), "alpha schema private") {
			t.Fatalf("team_admin sensitive admin endpoint was not fail-closed for %s: status=%d body=%s", path, status, body)
		}
	}
	rootText2SQLStatus, rootText2SQLBody := rootGet("/admin/text2sql?window=7d")
	if rootText2SQLStatus != http.StatusOK {
		t.Fatalf("privileged Text2SQL overview failed: status=%d body=%s", rootText2SQLStatus, rootText2SQLBody)
	}
	for _, expected := range []string{"alpha question private", "beta question private", "alpha schema private", "beta schema private", text2SQLProfileCredential} {
		if !strings.Contains(string(rootText2SQLBody), expected) {
			t.Fatalf("privileged Text2SQL overview lost raw compatibility marker %q: %s", expected, rootText2SQLBody)
		}
	}
	for _, check := range []struct {
		path, ownID, otherID string
	}{
		{path: "/admin/policies/decisions?team_id=team_beta", ownID: "policy-alpha-scope", otherID: "policy-beta-scope"},
		{path: "/admin/approvals?team_id=team_beta", ownID: "approval-alpha-scope", otherID: "approval-beta-scope"},
		{path: "/admin/security/secrets?team_id=team_beta", ownID: "secret-alpha-scope", otherID: "secret-beta-scope"},
	} {
		status, body := teamGet(check.path)
		if status != http.StatusOK || !strings.Contains(string(body), check.ownID) {
			t.Fatalf("team_admin governance list lost own scope for %s: status=%d body=%s", check.path, status, body)
		}
		for _, denied := range []string{check.otherID, "beta-owner@example.com", "alpha-owner@example.com", text2SQLProfileCredential, "beta policy private", "beta approval private", "beta secret private"} {
			if strings.Contains(string(body), denied) {
				t.Fatalf("team_admin governance list %s exposed %q: %s", check.path, denied, body)
			}
		}
	}
	rootPolicyStatus, rootPolicyBody := rootGet("/admin/policies/decisions?team_id=team_beta")
	if rootPolicyStatus != http.StatusOK || !strings.Contains(string(rootPolicyBody), "policy-beta-scope") || !strings.Contains(string(rootPolicyBody), "beta-owner@example.com") {
		t.Fatalf("privileged governance list lost raw compatibility: status=%d body=%s", rootPolicyStatus, rootPolicyBody)
	}

	sessionsStatus, sessionsBody := teamGet("/admin/sessions?days=365")
	var sessionsPayload struct {
		Sessions []store.SessionSummary `json:"sessions"`
	}
	if err := json.Unmarshal(sessionsBody, &sessionsPayload); err != nil {
		t.Fatal(err)
	}
	if sessionsStatus != http.StatusOK || len(sessionsPayload.Sessions) != 1 ||
		sessionsPayload.Sessions[0].SessionID != "scope-session-shared" || sessionsPayload.Sessions[0].Requests != 1 ||
		sessionsPayload.Sessions[0].LastMessage != "alpha-tag-safe" {
		t.Fatalf("team_admin session list escaped team scope: status=%d payload=%+v body=%s", sessionsStatus, sessionsPayload, sessionsBody)
	}
	flightStatus, flightBody := teamGet("/admin/sessions/scope-session-shared/flight-recorder")
	if flightStatus != http.StatusOK || !strings.Contains(string(flightBody), "req-alpha-trace") {
		t.Fatalf("team_admin flight recorder lost own request: status=%d body=%s", flightStatus, flightBody)
	}
	for _, denied := range []string{"req-beta-trace", "beta-tag", "req-padded-alpha-trace"} {
		if strings.Contains(string(flightBody), denied) {
			t.Fatalf("team_admin flight recorder exposed %q: %s", denied, flightBody)
		}
	}
	if status, body := teamGet("/admin/sessions/scope-session-beta-only/flight-recorder"); status != http.StatusNotFound {
		t.Fatalf("team_admin could enumerate another team's session: status=%d body=%s", status, body)
	}

	promptStatus, promptBody := teamGet("/admin/prompts?q=alpha-tag-safe")
	if promptStatus != http.StatusOK || !strings.Contains(string(promptBody), "req-alpha-trace") {
		t.Fatalf("team_admin prompt search lost own redacted prompt: status=%d body=%s", promptStatus, promptBody)
	}
	for _, query := range []string{"alpha-tag-private", "beta-tag-safe", "beta-tag-private"} {
		status, body := teamGet("/admin/prompts?q=" + query)
		if status != http.StatusOK || strings.Contains(string(body), "req-alpha-trace") || strings.Contains(string(body), "req-beta-trace") {
			t.Fatalf("team_admin prompt search exposed raw or cross-team match for %q: status=%d body=%s", query, status, body)
		}
	}
	mcpStatus, mcpBody := teamGet("/admin/mcp/requests?server=scope-mcp&tool=scope-read")
	if mcpStatus != http.StatusOK || !strings.Contains(string(mcpBody), "req-alpha-trace") {
		t.Fatalf("team_admin MCP request list lost own row: status=%d body=%s", mcpStatus, mcpBody)
	}
	for _, denied := range []string{"req-beta-trace", "req-beta-only-trace", "req-padded-alpha-trace"} {
		if strings.Contains(string(mcpBody), denied) {
			t.Fatalf("team_admin MCP request list exposed %q: %s", denied, mcpBody)
		}
	}

	ipsStatus, ipsBody := teamGet("/admin/ips")
	var ipsPayload struct {
		IPs []store.IPSummary `json:"ips"`
	}
	if err := json.Unmarshal(ipsBody, &ipsPayload); err != nil {
		t.Fatal(err)
	}
	if ipsStatus != http.StatusOK || len(ipsPayload.IPs) != 1 || ipsPayload.IPs[0].IP != "198.51.100.10" || ipsPayload.IPs[0].Requests != 1 || ipsPayload.IPs[0].DistinctKeys != 1 {
		t.Fatalf("team_admin IP list escaped team scope: status=%d payload=%+v body=%s", ipsStatus, ipsPayload, ipsBody)
	}

	ipDetailStatus, ipDetailBody := teamGet("/admin/ips/198.51.100.10")
	var ipDetail store.IPDetail
	if err := json.Unmarshal(ipDetailBody, &ipDetail); err != nil {
		t.Fatal(err)
	}
	if ipDetailStatus != http.StatusOK || ipDetail.Stats.Requests != 1 || ipDetail.Stats.DistinctKeys != 1 || len(ipDetail.Recent) != 1 || ipDetail.Recent[0].ID != "req-alpha-trace" {
		t.Fatalf("team_admin shared IP detail escaped team scope: status=%d detail=%+v body=%s", ipDetailStatus, ipDetail, ipDetailBody)
	}
	if len(ipDetail.ByModel) != 1 || ipDetail.ByModel[0].Key != "alpha-model" || len(ipDetail.ByKey) != 1 || ipDetail.ByKey[0].Key != alphaKeyOut.APIKey.ID {
		t.Fatalf("team_admin shared IP breakdown escaped team scope: %+v", ipDetail)
	}
	if status, body := teamGet("/admin/ips/198.51.100.20"); status != http.StatusNotFound {
		t.Fatalf("team_admin could enumerate other-team IP: status=%d body=%s", status, body)
	}

	for field, expected := range map[string]string{
		"model":    "alpha-model",
		"ip":       "198.51.100.10",
		"language": "ko",
		"tag":      "alpha-tag",
	} {
		status, body := teamGet("/admin/suggest?field=" + field)
		var payload struct {
			Values []string `json:"values"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK || len(payload.Values) != 1 || payload.Values[0] != expected {
			t.Fatalf("team_admin %s suggestions escaped team scope: status=%d values=%v body=%s", field, status, payload.Values, body)
		}
	}
	const malformedClientIP = "client-ip-sensitive@example.com"
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: "req-alpha-malformed-ip", TraceID: "trace-malformed-ip", APIKeyID: alphaKeyOut.APIKey.ID,
		Method: http.MethodPost, Endpoint: "/v1/chat/completions", Model: "alpha-model",
		ClientIP: malformedClientIP, StatusCode: http.StatusOK, CreatedAt: createdAt.Add(time.Second),
	}}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/admin/requests?limit=20", "/admin/ips", "/admin/suggest?field=ip"} {
		status, body := teamGet(path)
		if status != http.StatusOK || strings.Contains(string(body), malformedClientIP) {
			t.Fatalf("team_admin malformed IP projection failed for %s: status=%d body=%s", path, status, body)
		}
		if strings.HasPrefix(path, "/admin/requests") && !strings.Contains(string(body), externalIPUnknown) {
			t.Fatalf("team_admin request list did not mark malformed IP as unknown: %s", body)
		}
	}
	if status, body := teamGet("/admin/ips/" + malformedClientIP); status != http.StatusBadRequest || strings.Contains(string(body), malformedClientIP) {
		t.Fatalf("malformed IP detail was accepted or reflected: status=%d body=%s", status, body)
	}
	if status, body := teamGet("/admin/requests/req-beta-trace/note"); status != http.StatusForbidden {
		t.Fatalf("team_admin could read other-team request note: status=%d body=%s", status, body)
	}
	if status, body := teamGet("/admin/requests/req-alpha-trace/note"); status != http.StatusOK || !strings.Contains(string(body), "alpha-tag") {
		t.Fatalf("team_admin could not read own-team request note: status=%d body=%s", status, body)
	}
	for _, run := range []store.WorkflowRun{
		{ID: "workflow-alpha-trace", WorkflowID: "workflow-alpha", Team: "Alpha", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
		{ID: "workflow-beta-trace", WorkflowID: "workflow-beta", Team: "team_beta", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
		{ID: "workflow-padded-alpha-trace", WorkflowID: "workflow-padded-alpha", Team: " Alpha ", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
	} {
		if err := db.RecordWorkflowRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	for _, run := range []store.AIAppRun{
		{ID: "app-alpha-trace", AppID: "app-alpha", Team: "team_alpha", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
		{ID: "app-beta-trace", AppID: "app-beta", Team: "Beta", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
		{ID: "app-padded-alpha-trace", AppID: "app-padded-alpha", Team: " team_alpha ", TraceID: "trace-shared", CreatedAt: createdAt.Format(time.RFC3339Nano)},
	} {
		if err := db.RecordAIAppRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	for _, requestPath := range []string{
		"/admin/requests/req-beta-trace/trace",
		"/admin/requests/req-beta-trace/explain",
		"/admin/requests/req-beta-trace/links",
		"/admin/flow-map?request_id=req-beta-trace",
		"/admin/llm/traces/req-beta-trace",
		"/admin/requests/req-beta-only-trace/trace",
		"/admin/requests/req-beta-only-trace/explain",
		"/admin/requests/req-beta-only-trace/links",
		"/admin/llm/traces/req-beta-only-trace",
		"/admin/requests/req-padded-alpha-trace/trace",
		"/admin/requests/req-padded-alpha-trace/explain",
		"/admin/requests/req-padded-alpha-trace/links",
		"/admin/llm/traces/req-padded-alpha-trace",
	} {
		request, _ := http.NewRequest(http.MethodGet, proxy.URL+requestPath, nil)
		request.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("team_admin cross-team trace %s status = %d, want %d", requestPath, response.StatusCode, http.StatusForbidden)
		}
	}
	for _, requestPath := range []string{
		"/admin/requests/req-alpha-trace/trace",
		"/admin/requests/req-alpha-trace/explain",
		"/admin/requests/req-alpha-trace/links",
		"/admin/flow-map?request_id=req-alpha-trace",
		"/admin/llm/traces/req-alpha-trace",
	} {
		request, _ := http.NewRequest(http.MethodGet, proxy.URL+requestPath, nil)
		request.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("team_admin own-team trace %s status = %d, want %d", requestPath, response.StatusCode, http.StatusOK)
		}
	}
	for _, requestPath := range []string{
		"/admin/requests/diff?a=req-alpha-trace&b=req-beta-trace",
		"/admin/requests/diff?a=req-alpha-trace&b=req-padded-alpha-trace",
	} {
		request, _ := http.NewRequest(http.MethodGet, proxy.URL+requestPath, nil)
		request.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("team_admin cross-team diff %s status = %d, want %d", requestPath, response.StatusCode, http.StatusForbidden)
		}
	}
	ownDiffRequest, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/requests/diff?a=req-alpha-trace&b=req-alpha-trace", nil)
	ownDiffRequest.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	ownDiffResponse, err := http.DefaultClient.Do(ownDiffRequest)
	if err != nil {
		t.Fatal(err)
	}
	ownDiffResponse.Body.Close()
	if ownDiffResponse.StatusCode != http.StatusOK {
		t.Fatalf("team_admin own-team diff status = %d, want %d", ownDiffResponse.StatusCode, http.StatusOK)
	}
	traceListRequest, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/llm/traces?limit=10", nil)
	traceListRequest.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	traceListResponse, err := http.DefaultClient.Do(traceListRequest)
	if err != nil {
		t.Fatal(err)
	}
	traceListBody, _ := io.ReadAll(traceListResponse.Body)
	traceListResponse.Body.Close()
	if traceListResponse.StatusCode != http.StatusOK || !strings.Contains(string(traceListBody), "req-alpha-trace") || strings.Contains(string(traceListBody), "req-beta-trace") {
		t.Fatalf("team_admin trace list escaped team scope: status=%d body=%s", traceListResponse.StatusCode, traceListBody)
	}
	traceScopeBody := func(token string) (int, string) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/traces/trace-shared", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, string(body)
	}
	teamTraceStatus, teamTraceBody := traceScopeBody(teamTok.AccessToken)
	for _, allowed := range []string{"req-alpha-trace", "workflow-alpha-trace", "app-alpha-trace", "code-req-alpha-trace"} {
		if !strings.Contains(teamTraceBody, allowed) {
			t.Fatalf("team_admin trace response missing own-team %q: status=%d body=%s", allowed, teamTraceStatus, teamTraceBody)
		}
	}
	for _, denied := range []string{
		"req-beta-trace", "workflow-beta-trace", "app-beta-trace", "code-req-beta-trace",
		"req-beta-only-trace", "code-req-beta-only-trace",
		"req-padded-alpha-trace", "workflow-padded-alpha-trace", "app-padded-alpha-trace", "code-req-padded-alpha-trace",
	} {
		if strings.Contains(teamTraceBody, denied) {
			t.Fatalf("team_admin trace response exposed other-team %q: status=%d body=%s", denied, teamTraceStatus, teamTraceBody)
		}
	}
	if teamTraceStatus != http.StatusOK {
		t.Fatalf("team_admin trace response status=%d body=%s", teamTraceStatus, teamTraceBody)
	}
	rootTraceStatus, rootTraceBody := traceScopeBody(rootTok.AccessToken)
	if rootTraceStatus != http.StatusOK || !strings.Contains(rootTraceBody, "req-beta-trace") ||
		!strings.Contains(rootTraceBody, "workflow-beta-trace") || !strings.Contains(rootTraceBody, "app-beta-trace") ||
		!strings.Contains(rootTraceBody, "code-req-beta-trace") {
		t.Fatalf("super_admin trace response lost cross-team rows: status=%d body=%s", rootTraceStatus, rootTraceBody)
	}

	patchOther, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/api-keys/"+betaKeyOut.APIKey.ID, strings.NewReader(`{"scopes":["chat:completion"]}`))
	patchOther.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	patchOther.Header.Set("Content-Type", "application/json")
	patchOtherResp, err := http.DefaultClient.Do(patchOther)
	if err != nil {
		t.Fatal(err)
	}
	patchOtherResp.Body.Close()
	if patchOtherResp.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not patch other-team api key, got %d", patchOtherResp.StatusCode)
	}
	patchEscalate, _ := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/api-keys/"+alphaKeyOut.APIKey.ID, strings.NewReader(`{"role":"admin"}`))
	patchEscalate.Header.Set("Authorization", "Bearer "+teamTok.AccessToken)
	patchEscalate.Header.Set("Content-Type", "application/json")
	patchEscalateResp, err := http.DefaultClient.Do(patchEscalate)
	if err != nil {
		t.Fatal(err)
	}
	patchEscalateResp.Body.Close()
	if patchEscalateResp.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not escalate own api key role, got %d", patchEscalateResp.StatusCode)
	}

	otherPreview := postJSON(t, proxy.URL+"/admin/routing/preview", teamTok.AccessToken, map[string]any{
		"api_key_id": betaKeyOut.APIKey.ID,
		"model":      "vibe/auto",
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
	})
	otherPreview.Body.Close()
	if otherPreview.StatusCode != http.StatusForbidden {
		t.Fatalf("team_admin should not preview routing for other-team api key, got %d", otherPreview.StatusCode)
	}
	ownPreview := postJSON(t, proxy.URL+"/admin/routing/preview", teamTok.AccessToken, map[string]any{
		"api_key_id": ownKeyOut.APIKey.ID,
		"model":      "vibe/auto",
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
	})
	ownPreview.Body.Close()
	if ownPreview.StatusCode != http.StatusOK {
		t.Fatalf("team_admin should preview own-team api key, got %d", ownPreview.StatusCode)
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
	auditReq, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/audit/auth-events?limit=20", nil)
	auditReq.Header.Set("Authorization", "Bearer "+rotated.AccessToken)
	auditResp, err := http.DefaultClient.Do(auditReq)
	if err != nil {
		t.Fatal(err)
	}
	var auditOut struct {
		Events []store.AuthEvent `json:"events"`
	}
	if err := json.NewDecoder(auditResp.Body).Decode(&auditOut); err != nil {
		t.Fatal(err)
	}
	auditResp.Body.Close()
	if auditResp.StatusCode != http.StatusOK {
		t.Fatalf("auth audit API should allow admin JWT, got %d", auditResp.StatusCode)
	}
	seenLoginSuccess, seenLoginFailed := false, false
	for _, event := range auditOut.Events {
		if event.EventType == "login_success" {
			seenLoginSuccess = true
		}
		if event.EventType == "login_failed" {
			seenLoginFailed = true
		}
	}
	if !seenLoginSuccess || !seenLoginFailed {
		t.Fatalf("expected login_success and login_failed audit events, got %+v", auditOut.Events)
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

func TestModelsEndpointDoesNotRequireAuthWhenAuthEnabled(t *testing.T) {
	var upstreamAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4.1-mini","object":"model"}]}`))
	}))
	defer upstream.Close()
	_, proxy := newAuthTestServer(t, upstream.URL)
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("models endpoint should be public, got %d: %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("X-Api-Key-Id"); got != "anonymous" {
		t.Fatalf("expected anonymous api key id, got %q", got)
	}
	if upstreamAuth != "Bearer secret" {
		t.Fatalf("upstream should still receive provider key, got %q", upstreamAuth)
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

func TestGeneratedAPIKeyDefaultsScopesAndAuthenticates(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		"name": "generated-default-scope",
	})
	defer createKey.Body.Close()
	if createKey.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createKey.Body)
		t.Fatalf("api key create failed: %d %s", createKey.StatusCode, body)
	}
	var created struct {
		APIKey struct {
			ID     string   `json:"id"`
			Scopes []string `json:"scopes"`
		} `json:"api_key"`
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(createKey.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Secret == "" || !strings.HasPrefix(created.Secret, "vc_sk_") {
		t.Fatalf("expected generated vc_sk secret, got %#v", created)
	}
	if !hasScope(created.APIKey.Scopes, "chat:completion") {
		t.Fatalf("generated key should default chat scope, got %+v", created.APIKey.Scopes)
	}
	rec, found, err := db.GetAPIKey(context.Background(), created.APIKey.ID)
	if err != nil || !found {
		t.Fatalf("stored key lookup failed found=%v err=%v", found, err)
	}
	if rec.KeyHash == "" || rec.KeyHash == created.Secret {
		t.Fatalf("api key plaintext must not be stored; hash=%q secret=%q", rec.KeyHash, created.Secret)
	}
	if !hasScope(rec.Scopes, "chat:completion") {
		t.Fatalf("stored generated key should have default scopes, got %+v", rec.Scopes)
	}

	okResp := postJSON(t, proxy.URL+"/v1/chat/completions", created.Secret, chatBody("gpt-4.1-mini", false))
	defer okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(okResp.Body)
		t.Fatalf("generated key should authenticate and allow chat, got %d: %s", okResp.StatusCode, body)
	}
	if got := okResp.Header.Get("X-Api-Key-Id"); got != created.APIKey.ID {
		t.Fatalf("expected X-Api-Key-Id %q, got %q", created.APIKey.ID, got)
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

func TestAPIKeyExpiryIPRestrictionAndServiceAccountAccess(t *testing.T) {
	var upstreamCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()
	db, proxy := newAuthTestServer(t, upstream.URL)
	defer proxy.Close()
	ctx := context.Background()

	expiredSecret := "vc_sk_expired_lifecycle"
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "key_expired_lifecycle", Name: "expired", KeyHash: hashProxyKey(expiredSecret), Status: "active",
		Scopes: []string{"chat:completion"}, ExpiresAt: time.Now().UTC().Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	expiredResp := postJSON(t, proxy.URL+"/v1/chat/completions", expiredSecret, chatBody("gpt-4.1-mini", false))
	expiredResp.Body.Close()
	if expiredResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired key should be denied, got %d", expiredResp.StatusCode)
	}

	ipSecret := "vc_sk_ip_restricted"
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "key_ip_restricted", Name: "ip-restricted", KeyHash: hashProxyKey(ipSecret), Status: "active",
		Scopes: []string{"chat:completion"}, AllowedIPs: []string{"203.0.113.0/24"},
	}); err != nil {
		t.Fatal(err)
	}
	ipResp := postJSON(t, proxy.URL+"/v1/chat/completions", ipSecret, chatBody("gpt-4.1-mini", false))
	ipResp.Body.Close()
	if ipResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("IP-restricted key should be denied from httptest IP, got %d", ipResp.StatusCode)
	}

	serviceSecret := "vc_sa_service_account_ok"
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "key_service_account_ok", Name: "service", KeyHash: hashProxyKey(serviceSecret), Status: "active",
		Role: "service_account", ServiceAccountID: "svc_ci", Scopes: []string{"chat:completion", "models:read"},
	}); err != nil {
		t.Fatal(err)
	}
	okResp := postJSON(t, proxy.URL+"/v1/chat/completions", serviceSecret, chatBody("gpt-4.1-mini", false))
	okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("service account key should allow chat, got %d", okResp.StatusCode)
	}
	if upstreamCalls != 1 {
		t.Fatalf("expected only service account request to hit upstream, got %d", upstreamCalls)
	}

	events, _ := db.ListAuditEvents(ctx, 20)
	seenExpired, seenIPDenied := false, false
	for _, e := range events {
		if e.EventType == "api_key_denied" && e.APIKeyID == "key_expired_lifecycle" && strings.Contains(e.Detail, "expired") {
			seenExpired = true
		}
		if e.EventType == "ip_denied" && e.APIKeyID == "key_ip_restricted" {
			seenIPDenied = true
		}
	}
	if !seenExpired || !seenIPDenied {
		t.Fatalf("expected expired and ip_denied audit events, got %#v", events)
	}
}
