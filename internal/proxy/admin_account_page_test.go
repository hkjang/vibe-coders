package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAdminAccountPageHTTPAuthorizationAndLegacyParity(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Add(-time.Minute)
	for _, team := range []store.AuthTeam{{ID: "accounts-alpha", Name: "계정 개발팀"}, {ID: "accounts-beta", Name: "계정 운영팀"}} {
		if err := db.UpsertAuthTeam(t.Context(), team); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 32 {
		id := fmt.Sprintf("account-http-%02d", index)
		if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: id, Email: id + "@example.test", Name: id,
			Role: "developer", Status: "active", PasswordHash: "not-public-account-hash", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
		if index < 31 {
			team := "accounts-alpha"
			if index > 25 {
				team = "accounts-beta"
			}
			if err := db.SetUserTeam(t.Context(), id, team, "developer"); err != nil {
				t.Fatal(err)
			}
		}
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "account-page.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "account-page-legacy-fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "account-page-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	legacyServer, legacyGateway := serveAdminModelsTestStore(t, "account-page-legacy-fixture", db)
	legacyServer.cfg.Auth.AdminReadonlyToken = "account-page-readonly-fixture"
	admin := issueLLMScopedTestToken(t, db, server, "account-admin", "super_admin", "", []string{"admin:read"}, now)
	team := issueLLMScopedTestToken(t, db, server, "account-team-admin", "team_admin", "accounts-alpha", []string{"admin:read"}, now)
	empty := issueLLMScopedTestToken(t, db, server, "account-empty-admin", "team_admin", "", []string{"admin:read"}, now)
	denied := issueLLMScopedTestToken(t, db, server, "account-no-scope", "developer", "accounts-alpha", []string{"llm:invoke"}, now)
	read := func(t *testing.T, token, query string, status int) map[string]any {
		t.Helper()
		base := gateway.URL
		if token == "account-page-legacy-fixture" || token == "account-page-readonly-fixture" {
			base = legacyGateway.URL
		}
		req, err := http.NewRequest(http.MethodGet, base+"/admin/users"+query, nil)
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
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("account status/cache mismatch: got %d, want %d", response.StatusCode, status)
		}
		if strings.Contains(string(body), "password_hash") || strings.Contains(string(body), "not-public-account-hash") {
			t.Fatal("credential metadata leaked")
		}
		var result map[string]any
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, tc := range []struct {
		name, token, query string
		total, count       int
	}{
		{"admin default", admin, "", 32, 25},
		{"admin second page", admin, "&offset=25", 32, 7},
		{"legacy token", "account-page-legacy-fixture", "", 32, 25},
		{"readonly legacy token", "account-page-readonly-fixture", "", 32, 25},
		{"team default", team, "", 26, 25},
		{"team second page", team, "&offset=25", 26, 1},
		{"team out of range", team, "&offset=100", 26, 0},
		{"foreign filter", team, "&team_id=accounts-beta", 0, 0},
		{"foreign search", team, "&q=accounts-beta", 0, 0},
		{"empty team scope", empty, "", 1, 1},
		{"team display search", admin, "&q=" + "%EA%B3%84%EC%A0%95%20%EC%9A%B4%EC%98%81%ED%8C%80", 5, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := read(t, tc.token, "?view=accounts"+tc.query, 200)
			if body["total"] != float64(tc.total) || len(body["accounts"].([]any)) != tc.count || len(body) != 4 {
				t.Fatal("account page contract mismatch")
			}
		})
	}
	for _, token := range []string{admin, team, empty, "account-page-legacy-fixture"} {
		legacy := read(t, token, "", 200)
		usage := read(t, token, "?view=usage", 200)
		page := read(t, token, "?view=accounts&limit=100", 200)
		if len(legacy) != 3 || len(usage) != 2 || usage["auth_users"] != nil || !reflect.DeepEqual(legacy["users"], usage["users"]) || !reflect.DeepEqual(legacy["team_names"], usage["team_names"]) {
			t.Fatal("legacy usage contract changed")
		}
		accounts := map[string]map[string]any{}
		for _, item := range page["accounts"].([]any) {
			account := item.(map[string]any)
			accounts[account["id"].(string)] = account
		}
		old := legacy["auth_users"].([]any)
		if len(old) != len(accounts) {
			t.Fatal("legacy/account scope count differs")
		}
		for _, item := range old {
			account := item.(map[string]any)
			for key, value := range account {
				if !reflect.DeepEqual(accounts[account["id"].(string)][key], value) {
					t.Fatal("legacy account metadata differs")
				}
			}
		}
	}
	for _, query := range []string{"?view=accounts", "?view=usage", ""} {
		read(t, "", query, 401)
		read(t, denied, query, 401)
	}
	for _, query := range []string{"view=unknown", "view=accounts&view=usage", "view=accounts&limit=0", "view=accounts&limit=101", "view=accounts&limit=no", "view=accounts&offset=-1", "view=accounts&offset=1000001", "view=accounts&q=a&q=b", "view=accounts&q=%FF", "view=accounts&q=a%00b", "view=accounts&sort=email", "view=accounts&sort=email:down", "view=accounts&sort=password_hash:asc", "view=accounts&sort=email:asc,email:desc", "view=accounts&team_id=a&team_id=b"} {
		read(t, admin, "?"+query, 400)
	}
	for _, query := range []string{"?view=accounts&q=%ZZ", "?view=accounts&q=a;b"} {
		read(t, admin, query, 400)
	}
	// The existing team API accepts identifiers beyond the new search-input
	// bounds. Authenticated scope must continue to match those identifiers.
	for index, teamID := range []string{"team_" + strings.Repeat("x", 1024), "team_with\nseparator"} {
		t.Run(fmt.Sprintf("legacy team scope %d", index), func(t *testing.T) {
			teamName := fmt.Sprintf("%d ", index) + strings.Repeat("기존 팀 이름 ", 2048)
			if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: teamID, Name: teamName}); err != nil {
				t.Fatal(err)
			}
			id := fmt.Sprintf("usr_legacy_account_%d", index)
			if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: id, Email: id + "@example.test", Name: strings.Repeat("기존 계정 ", 2048), Role: "developer", Status: "active", CreatedAt: now}); err != nil {
				t.Fatal(err)
			}
			if err := db.SetUserTeam(t.Context(), id, teamID, "developer"); err != nil {
				t.Fatal(err)
			}
			token := issueLLMScopedTestToken(t, db, server, fmt.Sprintf("legacy_team_admin_%d", index), "team_admin", teamID, []string{"admin:read"}, now)
			page := read(t, token, "?view=accounts", 200)
			legacy := read(t, token, "", 200)
			if page["total"] != float64(1) || len(page["accounts"].([]any)) != 1 || len(legacy["auth_users"].([]any)) != 1 {
				t.Fatal("legacy team scope or account count changed")
			}
			account := page["accounts"].([]any)[0].(map[string]any)
			if account["id"] != id || account["team_id"] != teamID || account["team_name"] != teamName {
				t.Fatal("existing team metadata changed")
			}
			for key, value := range legacy["auth_users"].([]any)[0].(map[string]any) {
				if !reflect.DeepEqual(account[key], value) {
					t.Fatal("existing account metadata changed")
				}
			}
			foreign := read(t, token, "?view=accounts&team_id=accounts-alpha", 200)
			if foreign["total"] != float64(0) || len(foreign["accounts"].([]any)) != 0 {
				t.Fatal("legacy scope was broadened by a user filter")
			}
		})
	}
}

func TestAdminAccountPageStoppedAccountRoundTrip(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "account-state-fixture")
	request := func(method, path, body string) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, gateway.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer account-state-fixture")
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("account lifecycle request failed: %s %d", method, response.StatusCode)
		}
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	created := request(http.MethodPost, "/admin/users", `{"email":"account-state@example.test","password":"fixture-password-not-a-secret","name":"상태 검증 계정","role":"developer"}`)
	id := created["user"].(map[string]any)["id"].(string)
	for _, status := range []string{"disabled", "active"} {
		request(http.MethodPatch, "/admin/users/"+id, `{"status":"`+status+`"}`)
		page := request(http.MethodGet, "/admin/users?view=accounts&status="+status, "")
		accounts := page["accounts"].([]any)
		if page["total"] != float64(1) || len(accounts) != 1 {
			t.Fatal("changed account was not found by its persisted status")
		}
		account := accounts[0].(map[string]any)
		if account["id"] != id || account["status"] != status {
			t.Fatal("account status filter disagrees with the change API")
		}
		other := "active"
		if status == "active" {
			other = "disabled"
		}
		opposite := request(http.MethodGet, "/admin/users?view=accounts&status="+other, "")
		if opposite["total"] != float64(0) || len(opposite["accounts"].([]any)) != 0 {
			t.Fatal("status filter included an account with another persisted status")
		}
	}
}

func TestAdminAccountPageOpenAPIAndFailureProjection(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	op := paths["/admin/users"].(map[string]any)["get"].(map[string]any)
	if len(op["parameters"].([]any)) != 8 {
		t.Fatal("missing account query contract")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for name, count := range map[string]int{"AuthAccount": 8, "LegacyAuthAccount": 7, "AuthAccountPage": 4, "AdminUsersLegacy": 3, "AdminUserUsage": 2} {
		schema := schemas[name].(map[string]any)
		if len(schema["properties"].(map[string]any)) != count || len(schema["required"].([]string)) != count || schema["additionalProperties"] != false {
			t.Fatal("public account schema mismatch")
		}
	}
	_, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(gateway.URL + "/admin/users?view=accounts")
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
	if response.StatusCode != 500 || response.Header.Get("Cache-Control") != "no-store" || body.Error.Message != "failed to load login accounts" || body.Error.Code != "accounts_failed" {
		t.Fatal("account failure exposed internal database error")
	}
}
