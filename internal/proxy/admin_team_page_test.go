package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAdminTeamPageAuthorizationAndLegacyParity(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Add(-time.Minute)
	for index := range 32 {
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: fmt.Sprintf("team-page-%02d", index), Name: fmt.Sprintf("등록 팀 %02d", index), CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "teams.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "team-page-legacy-fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "team-page-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	legacyServer, legacyGateway := serveAdminModelsTestStore(t, "team-page-legacy-fixture", db)
	legacyServer.cfg.Auth.AdminReadonlyToken = "team-page-readonly-fixture"
	admin := issueLLMScopedTestToken(t, db, server, "team-page-admin", "super_admin", "", []string{"admin:read"}, now)
	team := issueLLMScopedTestToken(t, db, server, "team-page-member", "team_admin", "team-page-03", []string{"admin:read"}, now)
	empty := issueLLMScopedTestToken(t, db, server, "team-page-empty", "team_admin", "", []string{"admin:read"}, now)
	denied := issueLLMScopedTestToken(t, db, server, "team-page-denied", "developer", "team-page-03", []string{"llm:invoke"}, now)
	read := func(token, query string, status int) map[string]any {
		t.Helper()
		base := gateway.URL
		if token == "team-page-legacy-fixture" || token == "team-page-readonly-fixture" {
			base = legacyGateway.URL
		}
		req, err := http.NewRequest(http.MethodGet, base+"/admin/teams"+query, nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("team page status/cache mismatch: got %d want %d", response.StatusCode, status)
		}
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, tc := range []struct {
		token, query string
		total, count int
	}{
		{admin, "", 32, 25}, {admin, "&offset=25", 32, 7}, {admin, "&offset=100", 32, 0},
		{team, "", 1, 1}, {team, "&q=team-page-04", 0, 0}, {empty, "", 0, 0},
		{admin, "&id=team-page-03&limit=1", 1, 1}, {admin, "&id=team-page-0", 0, 0},
		{admin, "&id=team-page-03&q=team-page-04", 0, 0},
		{team, "&id=team-page-03", 1, 1}, {team, "&id=team-page-04", 0, 0},
		{empty, "&id=team-page-03", 0, 0},
		{"team-page-readonly-fixture", "&id=team-page-03", 1, 1},
		{"team-page-legacy-fixture", "", 32, 25}, {"team-page-readonly-fixture", "", 32, 25},
	} {
		page := read(tc.token, "?view=registered"+tc.query, 200)
		if page["total"] != float64(tc.total) || len(page["auth_teams"].([]any)) != tc.count || len(page) != 4 {
			t.Fatal("team page authorized count/shape mismatch")
		}
	}
	for _, token := range []string{admin, team, empty, "team-page-legacy-fixture"} {
		legacy := read(token, "", 200)
		usage := read(token, "?view=usage", 200)
		page := read(token, "?view=registered&limit=100", 200)
		if len(legacy) != 2 || len(usage) != 1 || !reflect.DeepEqual(usage["teams"], legacy["teams"]) || !reflect.DeepEqual(page["auth_teams"], legacy["auth_teams"]) {
			t.Fatal("legacy team data or usage contract changed")
		}
	}
	for _, query := range []string{"", "?view=registered", "?view=usage"} {
		read("", query, 401)
		read(denied, query, 401)
	}
	for _, query := range []string{"id=", "id=one&id=two", "id=%FF", "id=a%0Ab", "id=a%C2%85b", "id=" + strings.Repeat("x", 4097)} {
		read(admin, "?view=registered&"+query, 400)
	}
	for _, query := range []string{"view=unknown", "view=registered&view=usage", "view=registered&limit=0", "view=registered&limit=101", "view=registered&offset=-1", "view=registered&offset=1000001", "view=registered&q=a&q=b", "view=registered&q=%FF", "view=registered&q=%ZZ", "view=registered&q=a;b", "view=registered&sort=name", "view=registered&sort=name:down", "view=registered&sort=name:asc,name:desc", "view=registered&sort=secret:asc"} {
		read(admin, "?"+query, 400)
	}
	for index, id := range []string{"team-" + strings.Repeat("x", 1024), "team-with\nseparator"} {
		name := fmt.Sprintf("legacy-%d-", index) + strings.Repeat("가", 16385)
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: id, Name: name, CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
		token := issueLLMScopedTestToken(t, db, server, fmt.Sprintf("team-page-legacy-%d", index), "team_admin", id, []string{"admin:read"}, now)
		page := read(token, "?view=registered", 200)
		legacy := read(token, "", 200)
		if page["total"] != float64(1) || !reflect.DeepEqual(page["auth_teams"], legacy["auth_teams"]) {
			t.Fatal("existing authenticated team identifier or metadata changed")
		}
		if index == 0 {
			exact := read(token, "?view=registered&id="+url.QueryEscape(id)+"&limit=1", 200)
			if exact["total"] != float64(1) || !reflect.DeepEqual(exact["auth_teams"], legacy["auth_teams"]) {
				t.Fatal("long exact ID lookup changed registered metadata")
			}
		}
		foreign := read(token, "?view=registered&q=team-page-03", 200)
		if foreign["total"] != float64(0) {
			t.Fatal("search escaped the authenticated team scope")
		}
	}
}

func TestAdminTeamPageOpenAPIAndFailureProjection(t *testing.T) {
	spec := buildOpenAPISpec()
	op := spec["paths"].(map[string]any)["/admin/teams"].(map[string]any)["get"].(map[string]any)
	if len(op["parameters"].([]any)) != 6 {
		t.Fatal("missing registered-team query contract")
	}
	_, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(gateway.URL + "/admin/teams?view=registered")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Error struct{ Message, Code string }
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 500 || response.Header.Get("Cache-Control") != "no-store" || body.Error.Message != "failed to load registered teams" || body.Error.Code != "teams_failed" {
		t.Fatal("team page failure exposed internal query information")
	}
}
