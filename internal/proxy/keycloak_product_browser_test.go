//go:build linux

package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/appui"
	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
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

	var modelUpstreamMutations atomic.Int64
	modelUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			modelUpstreamMutations.Add(1)
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		owner := "other model owner"
		if strings.HasPrefix(r.URL.Path, "/model-b/") {
			owner = "selected model owner"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": []map[string]any{{
			"id": "catalog +%2F?&#/공유", "object": "model", "owned_by": owner, "created": 1700000000,
		}}})
	}))
	t.Cleanup(modelUpstream.Close)
	modelCipher, err := secret.New(cfg.Secret.GatewaySecret)
	if err != nil {
		t.Fatal("synthetic model cipher unavailable")
	}
	modelKey, err := modelCipher.Encrypt("isolated-model-read-key")
	if err != nil {
		t.Fatal("synthetic model key unavailable")
	}
	for i, suffix := range []string{"a", "b"} {
		// Two synthetic credential-shaped names deliberately collide after safe projection.
		if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
			Name: "vc_sk_" + strings.Repeat(suffix, 40), BaseURL: modelUpstream.URL + "/model-" + suffix,
			TimeoutMS: 1000, Enabled: true, Priority: 101 + i, EncryptedAPIKey: modelKey,
		}); err != nil {
			t.Fatal("synthetic model provider unavailable")
		}
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
	if err := db.UpsertPromptTemplate(t.Context(), store.PromptTemplate{
		ID: "handoff-opaque-asset", Name: "서로 다른 자산 이름", Category: "custom", Body: "Public bridge template body", Enabled: true, Status: "draft",
	}); err != nil {
		t.Fatal("synthetic prompt asset unavailable")
	}
	searchBoundary := time.Date(2026, time.November, 18, 3, 4, 5, 123000000, time.UTC)
	for i, offset := range []time.Duration{-time.Millisecond, 0, time.Millisecond} {
		id := fmt.Sprintf("handoff-search-%d", i)
		created := searchBoundary.Add(offset)
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: id, Model: "public-model", ClientIP: "2001:db8::7", Method: "POST", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: created},
			Prompts: []store.PromptLog{{ID: id + "-prompt", RequestID: id, Role: "user", ContentHash: id, ContentText: "public bridge prompt", RedactedText: "public bridge prompt", LanguageHint: "go", CreatedAt: created}},
		}); err != nil {
			t.Fatal("synthetic prompt boundary unavailable")
		}
	}
	for i, id := range []string{"SSO 규칙 +%2F?&#/exact", "other-routing-rule"} {
		rule := store.RoutingRule{ID: id, Enabled: false, Priority: 17 + i, MatchPattern: "billing-*",
			MinComplexity: 10, MaxComplexity: 90, TargetModel: "shared routing model", TargetProvider: "public-routing-provider",
			Note: "selected routing note", CreatedAt: time.Date(2026, time.November, 18, 1, 2, 3, 456000000, time.UTC)}
		if i == 1 {
			rule.Note = "other routing note"
		}
		if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
			t.Fatal("synthetic routing rule unavailable")
		}
	}

	const commonAccessID = "shared-access-id"
	const otherAccessID = "other-access-id"
	longAccessID := " 계정 +%2F?&#/ " + strings.Repeat("가", 1300) + " "
	accessIDs := []string{commonAccessID, otherAccessID, longAccessID}
	accessTime := time.Date(2026, time.November, 18, 1, 2, 3, 456000000, time.UTC)
	for i, id := range accessIDs {
		name := []string{"Shared access", "Other access", "Long access"}[i]
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: id, Name: name, CreatedAt: accessTime, UpdatedAt: accessTime}); err != nil {
			t.Fatal("access team fixture unavailable")
		}
		user := store.AuthUser{ID: id, Email: fmt.Sprintf("access-%d@example.invalid", i), Name: name + " account", PasswordHash: "disabled-access-fixture", Role: "viewer", Status: "disabled", CreatedAt: accessTime, UpdatedAt: accessTime}
		if err := db.CreateAuthUser(t.Context(), user); err != nil {
			t.Fatal("access account fixture unavailable")
		}
		if err := db.SetUserTeam(t.Context(), id, id, "member"); err != nil {
			t.Fatal("access membership fixture unavailable")
		}
		if i < 2 {
			key := store.APIKeyRecord{ID: id, Name: name + " key", KeyHash: "synthetic-access-hash-" + id, Owner: name + " owner", Team: id, Role: "viewer", Status: "active", Scopes: []string{"admin:read"}, BudgetLimitKRW: 1234, CreatedAt: accessTime}
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("access key fixture unavailable")
			}
		}
	}
	accessSnapshot := func() string {
		snapshot := []any{}
		teams, err := db.ListAuthTeams(t.Context())
		if err != nil {
			t.Fatal("access teams snapshot unavailable")
		}
		snapshot = append(snapshot, teams)
		for i, id := range accessIDs {
			user, found, err := db.AuthUserByID(t.Context(), id)
			if err != nil || !found {
				t.Fatal("access user snapshot unavailable")
			}
			team, err := db.PrimaryTeamForUser(t.Context(), id)
			if err != nil {
				t.Fatal("access membership snapshot unavailable")
			}
			snapshot = append(snapshot, user, user.PasswordHash, team)
			if i < 2 {
				key, found, err := db.FindActiveAPIKeyByHash(t.Context(), "synthetic-access-hash-"+id)
				if err != nil || !found {
					t.Fatal("access credential snapshot unavailable")
				}
				public, err := db.ListAPIKeysByID(t.Context(), id, nil)
				if err != nil {
					t.Fatal("access key snapshot unavailable")
				}
				snapshot = append(snapshot, key, key.KeyHash, public)
			}
		}
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal("access snapshot invalid")
		}
		return string(encoded)
	}
	accessBefore := accessSnapshot()

	schemaName := "SSO 스키마 +%2F?&#/exact"
	schemaTables := make([]string, 51)
	for i := range schemaTables {
		schemaTables[i] = fmt.Sprintf("schema_private_table_%03d", i)
	}
	for i, fixture := range []struct{ name, team string }{
		{schemaName, "shared-access-id"},
		{"public-schema", ""},
		{"schema-shared-by-name", "Shared access"},
		{"foreign-schema", "other-access-id"},
		{strings.Repeat("😀", 512), "shared-access-id"},
	} {
		text := "schema private approved text"
		if i == 4 {
			text = strings.Repeat("가", 16383) + "😀schema-final-tail"
		}
		if err := db.UpsertText2SQLSchema(t.Context(), store.Text2SQLSchema{Name: fixture.name, Team: fixture.team, Dialect: "postgres",
			SchemaText: text, AllowedTables: schemaTables, Enabled: i != 0, IsDefault: i == 0}); err != nil {
			t.Fatal("schema fixture unavailable")
		}
	}
	schemasBefore, err := db.ListText2SQLSchemas(t.Context())
	if err != nil {
		t.Fatal("schema baseline unavailable")
	}
	schemaBytesBefore, err := json.Marshal(schemasBefore)
	if err != nil {
		t.Fatal("schema baseline invalid")
	}

	rulesBefore, err := db.ListRoutingRules(t.Context())
	if err != nil {
		t.Fatal("routing baseline unavailable")
	}
	ruleBytesBefore, err := json.Marshal(rulesBefore)
	if err != nil {
		t.Fatal("routing baseline invalid")
	}

	skillName := "/스킬 +%2F?&#/"
	skillNames := []string{skillName, strings.Repeat("😀", 1024), "스킬 +%2F?&#", "__proto__"}
	for i, name := range skillNames {
		description, instructions, metadata := "같은 스킬 설명", "선택한 스킬 지침", "{\"selected\":\"metadata\"}"
		if i == 1 {
			description = strings.Repeat("가", 16383) + "😀skill-final-tail"
			instructions = description
			metadata = "{\"text\":\"" + description + "\"}"
		}
		if i == 2 {
			instructions = "다른 스킬 지침"
		}
		if i == 3 {
			instructions = "prototype-name skill instructions"
		}
		if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Description: description, Version: "2.3.4", Owner: "skill-owner", Status: "deprecated", RiskLevel: "high", AllowedModels: "selected-model-*", AllowedTools: "selected-tool", AllowedTeams: "other-access-id", DailyLimit: 7, Instructions: instructions, Metadata: metadata}, "skill-editor"); err != nil {
			t.Fatal("skill fixture unavailable")
		}
	}
	skillsSnapshot := func() string {
		skills, err := db.ListSkills(t.Context(), "")
		if err != nil {
			t.Fatal("skill snapshot unavailable")
		}
		rows := []any{skills}
		for _, sk := range skills {
			promotions, err := db.ListSkillPromotions(t.Context(), sk.Name, 200)
			if err != nil {
				t.Fatal("skill promotions unavailable")
			}
			fitness, err := db.ListSkillFitnessEvidence(t.Context(), sk.Name)
			if err != nil {
				t.Fatal("skill evidence unavailable")
			}
			runs, err := db.ListSkillRuns(t.Context(), sk.Name, 200)
			if err != nil {
				t.Fatal("skill runs unavailable")
			}
			rows = append(rows, promotions, fitness, runs)
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			t.Fatal("skill snapshot invalid")
		}
		return string(raw)
	}
	skillsBefore := skillsSnapshot()

	workflowID := " 워크플로 +%2F?&#/ "
	workflowIDs := []string{workflowID, strings.Repeat("😀", 1024), "other-workflow", "empty-workflow"}
	for i, id := range workflowIDs {
		wf := store.Workflow{ID: id, Name: "같은 워크플로 제목", Description: "선택한 워크플로 설명", AllowedTeams: "other-access-id", CreatedBy: "workflow-owner"}
		if i == 0 {
			wf.Steps = []store.WorkflowStep{
				{ID: "choose", Name: "입력 비교", Type: "condition", Condition: &store.WorkflowCondition{Operator: "equals", Value: "exact-input"}, Note: "조건 메모"},
				{ID: "finish", Name: "승인", Type: "approval", TimeoutMS: 5000, Note: "승인 메모"},
			}
			wf.Flow = &store.WorkflowFlow{Version: 1, Entry: "choose", Edges: []store.WorkflowEdge{{From: "choose", To: "finish", When: "true"}, {From: "choose", To: "$end", When: "false"}, {From: "finish", To: "$end", When: "next"}}}
		} else if i != 3 {
			wf.Steps = make([]store.WorkflowStep, 51)
			for j := range wf.Steps {
				wf.Steps[j] = store.WorkflowStep{Name: fmt.Sprintf("저장된 단계 %03d", j), Type: "chat", Ref: fmt.Sprintf("workflow-ref-%03d", j), TimeoutMS: 1200, MaxCostKRW: 3.5, MaxTokens: 100, AllowedTools: []string{"saved-tool"}, AllowedTables: []string{"saved-table"}, Note: strings.Repeat("가", 100) + "😀note-tail"}
			}
		}
		if i == 1 {
			wf.Description = strings.Repeat("가", 16383) + "😀workflow-final-tail"
		}
		if i == 2 {
			wf.Description = "다른 워크플로 설명"
		}
		if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
			t.Fatal("workflow fixture unavailable", err)
		}
	}
	workflowsSnapshot := func() string {
		workflows, err := db.ListWorkflows(t.Context())
		if err != nil {
			t.Fatal("workflow snapshot unavailable")
		}
		rows := []any{workflows}
		for _, wf := range workflows {
			versions, err := db.ListWorkflowVersions(t.Context(), wf.ID)
			if err != nil {
				t.Fatal("workflow versions unavailable")
			}
			rows = append(rows, versions)
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			t.Fatal("workflow snapshot invalid")
		}
		return string(raw)
	}
	workflowsBefore := workflowsSnapshot()

	workAppID := " 업무 앱 +%2F?&#/ "
	longWorkAppID := strings.Repeat("😀", 1024)
	for i, id := range []string{workAppID, longWorkAppID, "other-work-app"} {
		components := make([]store.AppComponent, 51)
		for j := range components {
			components[j] = store.AppComponent{Kind: "model", Ref: fmt.Sprintf("work-app-component-%03d", j), Label: fmt.Sprintf("참조 %d", j)}
		}
		description := "선택한 업무 앱 설명"
		if i == 1 {
			description = strings.Repeat("가", 16383) + "😀work-app-final-tail"
		}
		if i == 2 {
			description = "다른 앱의 설명"
		}
		if err := db.CreateWorkApp(t.Context(), store.WorkApp{ID: id, Title: "같은 업무 앱 제목", Description: description, Icon: "🧩",
			Components: components, AllowedTeams: "other-access-id", AllowedRoles: "developer", Status: "archived", Owner: "work-app-owner"}); err != nil {
			t.Fatal("work app fixture unavailable")
		}
	}
	workAppsSnapshot := func() string {
		apps, err := db.ListWorkApps(t.Context())
		if err != nil {
			t.Fatal("work app snapshot unavailable")
		}
		rows := []any{apps}
		for _, app := range apps {
			versions, err := db.ListWorkAppVersions(t.Context(), app.ID)
			if err != nil {
				t.Fatal("work app versions unavailable")
			}
			permissions, err := db.ListAppPermissions(t.Context(), app.ID)
			if err != nil {
				t.Fatal("work app permissions unavailable")
			}
			rows = append(rows, versions, permissions)
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			t.Fatal("work app snapshot invalid")
		}
		return string(raw)
	}
	workAppsBefore := workAppsSnapshot()

	assetsBefore, err := db.ListPromptTemplates(t.Context(), false)
	if err != nil {
		t.Fatal("asset baseline unavailable")
	}
	assetBytesBefore, err := json.Marshal(assetsBefore)
	if err != nil {
		t.Fatal("asset baseline invalid")
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
	grantControl := browserFixtureSecret(t)
	gateway := httptest.NewUnstartedServer(keycloakGrantFixture(t, server, db, grantControl, server.Routes()))
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
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + scratch, "TMPDIR=" + scratch, "APP_BASE_URL=" + gateway.URL, "VIBE_KEYCLOAK_PASSWORD=" + fixture.Password, "VIBE_GRANT_CONTROL=" + grantControl, "PLAYWRIGHT_BROWSERS_PATH=" + os.Getenv("PLAYWRIGHT_BROWSERS_PATH")}
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if command.Run() != nil {
		t.Fatal("Keycloak product browser checks failed; see the numeric-only summary")
	}
	if skillsSnapshot() != skillsBefore {
		t.Fatal("skill definitions, promotions, fitness evidence or runs changed during read-only handoff")
	}
	if workflowsSnapshot() != workflowsBefore {
		t.Fatal("workflow definitions or versions changed during read-only handoff")
	}
	if workAppsSnapshot() != workAppsBefore {
		t.Fatal("work app definitions, versions or permissions changed during read-only handoff")
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
	if json.Unmarshal(summaryBytes, &summary) != nil || summary.Status != "passed" || len(summary.Tests) != 41 {
		t.Fatal("Keycloak product summary incomplete")
	}
	seen := map[string]bool{}
	for _, test := range summary.Tests {
		if test.Status != "passed" || seen[test.Scenario] || (test.Scenario != "KEYCLOAK-LIVE-001" && test.Scenario != "KEYCLOAK-LIVE-002" && test.Scenario != "KEYCLOAK-LIVE-003" && test.Scenario != "KEYCLOAK-LIVE-004" && test.Scenario != "KEYCLOAK-LIVE-005" && test.Scenario != "KEYCLOAK-LIVE-006" && test.Scenario != "KEYCLOAK-LIVE-007" && test.Scenario != "KEYCLOAK-LIVE-008" && test.Scenario != "KEYCLOAK-LIVE-009" && test.Scenario != "KEYCLOAK-LIVE-010" && test.Scenario != "KEYCLOAK-LIVE-011" && test.Scenario != "KEYCLOAK-LIVE-012" && test.Scenario != "KEYCLOAK-LIVE-013" && test.Scenario != "KEYCLOAK-LIVE-014" && test.Scenario != "KEYCLOAK-LIVE-015" && test.Scenario != "KEYCLOAK-LIVE-016" && test.Scenario != "KEYCLOAK-LIVE-017" && test.Scenario != "KEYCLOAK-LIVE-018" && test.Scenario != "KEYCLOAK-LIVE-019" && test.Scenario != "KEYCLOAK-LIVE-020" && test.Scenario != "KEYCLOAK-LIVE-021" && test.Scenario != "KEYCLOAK-LIVE-022" && test.Scenario != "KEYCLOAK-LIVE-023" && test.Scenario != "KEYCLOAK-LIVE-024" && test.Scenario != "KEYCLOAK-LIVE-025" && test.Scenario != "KEYCLOAK-LIVE-026" && test.Scenario != "KEYCLOAK-LIVE-027" && test.Scenario != "KEYCLOAK-LIVE-028" && test.Scenario != "KEYCLOAK-LIVE-029" && test.Scenario != "KEYCLOAK-LIVE-030" && test.Scenario != "KEYCLOAK-LIVE-031" && test.Scenario != "KEYCLOAK-LIVE-032" && test.Scenario != "KEYCLOAK-LIVE-033" && test.Scenario != "KEYCLOAK-LIVE-034" && test.Scenario != "KEYCLOAK-LIVE-035" && test.Scenario != "KEYCLOAK-LIVE-036" && test.Scenario != "KEYCLOAK-LIVE-037" && test.Scenario != "KEYCLOAK-LIVE-038" && test.Scenario != "KEYCLOAK-LIVE-039" && test.Scenario != "KEYCLOAK-LIVE-040" && test.Scenario != "KEYCLOAK-LIVE-041") {
			t.Fatal("Keycloak product scenario failed or duplicated")
		}
		seen[test.Scenario] = true
	}
	for _, expected := range []struct{ email, role string }{{"existing@example.invalid", "admin"}, {"new@example.invalid", "admin"}, {"reader@example.invalid", "readonly_admin"}, {"routing-reader@example.invalid", "team_admin"}} {
		user, found, err := db.AuthUserByEmail(t.Context(), expected.email)
		if err != nil || !found || user.Role != expected.role || user.Status != "active" {
			t.Fatal("real IdP provisioning did not persist the expected account and role")
		}
		if expected.email == "existing@example.invalid" && (user.ID != "existing-product-user" || user.PasswordHash != "disabled-local-password") {
			t.Fatal("email collision replaced the protected local account")
		}
	}
	users, err := db.ListAuthUsers(t.Context())
	if err != nil || len(users) != 8 {
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
	if accessBefore != accessSnapshot() {
		t.Fatal("read-only handoff changed accounts, teams, memberships or credentials")
	}
	schemasAfter, err := db.ListText2SQLSchemas(t.Context())
	if err != nil {
		t.Fatal("schema verification unavailable")
	}
	schemaBytesAfter, err := json.Marshal(schemasAfter)
	if err != nil || string(schemaBytesBefore) != string(schemaBytesAfter) {
		t.Fatal("read-only handoff changed stored schemas")
	}
	rulesAfter, err := db.ListRoutingRules(t.Context())
	if err != nil {
		t.Fatal("routing verification unavailable")
	}
	ruleBytesAfter, err := json.Marshal(rulesAfter)
	if err != nil || string(ruleBytesBefore) != string(ruleBytesAfter) {
		t.Fatal("read-only handoff changed routing rules")
	}
	providersAfter, err := db.ListProviderConfigs(t.Context())
	if err != nil {
		t.Fatal("provider verification unavailable")
	}
	providerBytesAfter, err := json.Marshal(providersAfter)
	if err != nil || string(providerBytesBefore) != string(providerBytesAfter) {
		t.Fatal("read-only SSO handoff changed provider data")
	}
	assetsAfter, err := db.ListPromptTemplates(t.Context(), false)
	if err != nil {
		t.Fatal("asset verification unavailable")
	}
	assetBytesAfter, err := json.Marshal(assetsAfter)
	if err != nil || string(assetBytesBefore) != string(assetBytesAfter) {
		t.Fatal("read-only handoff changed prompt asset data")
	}
	if modelUpstreamMutations.Load() != 0 {
		t.Fatal("model navigation mutated an upstream")
	}
	t.Log("thirty-three real Keycloak HTTPS browser scenarios, scoped schema/access and persisted data preservation checks passed")
}
