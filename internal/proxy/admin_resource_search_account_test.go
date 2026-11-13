package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestResourceSearchAccountHTTPAuthorizationScopeAndDetail(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-account-search-session-secret"
	stamp := time.Now().UTC().Add(-time.Hour)
	for _, id := range []string{"alpha", "beta"} {
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: id, Name: id}); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 12 {
		id := fmt.Sprintf("search-account-%02d", i)
		if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: id, Email: id + "@example.invalid", Name: fmt.Sprintf("정산 조회 %02d", i), Role: "viewer", Status: "active", PasswordHash: "never-selected-fixture"}); err != nil {
			t.Fatal(err)
		}
		if i == 11 {
			continue
		}
		team := "alpha"
		if i == 10 {
			team = "beta"
		}
		if err := db.UpsertMembership(t.Context(), store.UserTeamMembership{UserID: id, TeamID: team, Role: "member", CreatedAt: stamp}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertMembership(t.Context(), store.UserTeamMembership{UserID: "search-account-00", TeamID: "beta", Role: "member", CreatedAt: stamp.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, role, team string
		scopes           []string
		status, count    int
		limited          bool
	}{
		{"admin", "admin", "", []string{"admin:read"}, 200, 10, true},
		{"readonly", "readonly_admin", "", []string{"admin:read"}, 200, 10, true},
		{"super", "super_admin", "", []string{"admin:read"}, 200, 10, true},
		{"alpha", "team_admin", "alpha", []string{"admin:read"}, 200, 10, false},
		{"beta", "team_admin", "beta", []string{"admin:read"}, 200, 1, false},
		{"empty", "team_admin", "", []string{"admin:read"}, 200, 1, false},
		{"prefix", "team_admin", "alp", []string{"admin:read"}, 200, 0, false},
		{"case", "team_admin", "ALPHA", []string{"admin:read"}, 200, 0, false},
		{"foreign", "team_admin", "foreign", []string{"admin:read"}, 200, 0, false},
		{"write", "admin", "", []string{"admin:write"}, 403, 0, false},
		{"security", "admin", "", []string{"security:read"}, 403, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "account-reader-"+tc.name, tc.role, tc.team, tc.scopes, time.Now().UTC().Add(-time.Minute))
			request, _ := http.NewRequest(http.MethodPost, gateway.URL+"/admin/resource-search", strings.NewReader(`{"query":"정산","kinds":["account"]}`))
			request.Header.Set("Authorization", "Bearer "+token)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status || response.Header.Get("Cache-Control") != "no-store" || !validRequestID(response.Header.Get("X-Request-ID")) {
				t.Fatalf("account search HTTP status=%d want=%d, cache=%t, request ID valid=%t", response.StatusCode, tc.status, response.Header.Get("Cache-Control") == "no-store", validRequestID(response.Header.Get("X-Request-ID")))
			}
			if tc.status != 200 {
				return
			}
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if json.NewDecoder(response.Body).Decode(&result) != nil || len(result.Groups) != 1 {
				t.Fatal("invalid metadata envelope")
			}
			group := result.Groups[0]
			if group.Kind != "account" || group.Status != "ok" || len(group.Items) != tc.count || group.Limited != tc.limited {
				t.Fatal("account scope or limit mismatch")
			}
			for _, item := range group.Items {
				if item.Kind != "account" {
					t.Fatal("unexpected kind")
				}
				query := url.Values{"view": {"accounts"}, "id": {item.ID}, "limit": {"1"}}
				detail, _ := http.NewRequest(http.MethodGet, gateway.URL+"/admin/users?"+query.Encode(), nil)
				detail.Header.Set("Authorization", "Bearer "+token)
				actual, err := http.DefaultClient.Do(detail)
				if err != nil {
					t.Fatal(err)
				}
				var page store.AuthAccountPage
				err = json.NewDecoder(actual.Body).Decode(&page)
				actual.Body.Close()
				if err != nil || actual.StatusCode != 200 || page.Total != 1 || len(page.Accounts) != 1 || page.Accounts[0].ID != item.ID || page.Accounts[0].Name != item.Title {
					t.Fatal("account search and existing exact detail disagree")
				}
				if tc.role == "team_admin" && page.Accounts[0].TeamID != tc.team {
					t.Fatal("secondary team broadened navigation")
				}
			}
		})
	}
	// A valid policy reader still receives no account navigation metadata when
	// requesting several kinds in the same read-only operation.
	token := issueLLMScopedTestToken(t, db, s, "account-policy-reader", "admin", "", []string{"security:read"}, time.Now().UTC().Add(-time.Minute))
	w := resourceSearchRequest(s, `{"query":"정산","kinds":["policy","account"]}`, token)
	var mixed struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &mixed) != nil || len(mixed.Groups) != 2 || mixed.Groups[0].Status != "ok" || mixed.Groups[1].Status != "forbidden" || len(mixed.Groups[1].Items) != 0 {
		t.Fatal("policy reader received account metadata or lost independent policy access")
	}
}

func TestResourceSearchAccountProjectionFeatureAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "synthetic-account-full", "synthetic-account-reader"
	s.cfg.Auth.APIKeyPrefix = "corp_"
	for i, row := range []store.AuthUser{
		{ID: "계정/%_!", Name: "정산 담당자"},
		{ID: "email-name", Name: "정산 person@example.com"},
		{ID: "corp_" + strings.Repeat("x", 43), Name: "정산 비밀 ID"},
		{ID: "long-name", Name: "정산 " + strings.Repeat("가", 257)},
		{ID: strings.Repeat("i", 513), Name: "정산 긴 ID"},
	} {
		row.Email = fmt.Sprintf("excluded-%d@example.invalid", i)
		row.PasswordHash = "excluded-password-hash"
		row.Role = "viewer"
		row.Status = "active"
		if err := db.CreateAuthUser(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	for _, token := range []string{"synthetic-account-full", "synthetic-account-reader"} {
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["provider","workflow","app","skill","mcp_upstream","policy","team","account"]}`, token)
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 8 {
			t.Fatal("eight-kind legacy metadata contract failed")
		}
		group := result.Groups[7]
		if group.Status != "ok" || len(group.Items) != 1 || group.Items[0].ID != "계정/%_!" {
			t.Fatal("account identity lost or unsafe name exposed")
		}
		for _, excluded := range []string{"email", "password", "created_at", "role", "status\":\"active", "team_id", "person@example.com", "corp_", "excluded-", "정산 긴 ID", "정산 비밀 ID"} {
			if strings.Contains(w.Body.String(), excluded) {
				t.Fatal("account navigation exposed excluded data")
			}
		}
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.access.users.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal(err)
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["account","workflow"]}`, "synthetic-account-reader")
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 || result.Groups[1].Status != "ok" {
			t.Fatal("runtime account visibility or independent result failed")
		}
	}
	schemas := resourceSearchOpenAPISchemas()
	request := schemas["ResourceSearchRequest"].(map[string]any)["properties"].(map[string]any)["kinds"].(map[string]any)
	if request["maxItems"] != 8 || len(request["items"].(map[string]any)["enum"].([]string)) != 8 {
		t.Fatal("account kind missing from request contract")
	}
}
