package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestResourceSearchTeamHTTPAuthorizationAndScope(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-team-search-session-secret"
	now := time.Now().UTC().Add(-time.Minute)
	for index := range 12 {
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: fmt.Sprintf("search-team-%02d", index), Name: fmt.Sprintf("정산 조회 %02d", index)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, role, team, query string
		scopes                  []string
		status, count           int
		limited                 bool
	}{
		{"admin", "admin", "", "정산", []string{"admin:read"}, 200, 10, true},
		{"reader", "readonly_admin", "", "정산", []string{"admin:read"}, 200, 10, true},
		{"team", "team_admin", "search-team-11", "정산", []string{"admin:read"}, 200, 1, false},
		{"foreign", "team_admin", "search-team-11", "조회 00", []string{"admin:read"}, 200, 0, false},
		{"empty", "team_admin", "", "정산", []string{"admin:read"}, 200, 0, false},
		{"prefix", "team_admin", "search-team-1", "정산", []string{"admin:read"}, 200, 0, false},
		{"write", "admin", "", "정산", []string{"admin:write"}, 403, 0, false},
		{"security", "admin", "", "정산", []string{"security:read"}, 403, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "search-"+tc.name, tc.role, tc.team, tc.scopes, now)
			input, _ := json.Marshal(map[string]any{"query": tc.query, "kinds": []string{"team"}})
			request, err := http.NewRequest(http.MethodPost, gateway.URL+"/admin/resource-search", strings.NewReader(string(input)))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+token)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status || response.Header.Get("Cache-Control") != "no-store" || !validRequestID(response.Header.Get("X-Request-ID")) {
				t.Fatal("HTTP search status, cache or request ID mismatch")
			}
			if tc.status != 200 {
				return
			}
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if json.NewDecoder(response.Body).Decode(&result) != nil || len(result.Groups) != 1 {
				t.Fatal("invalid search envelope")
			}
			group := result.Groups[0]
			if group.Kind != "team" || group.Status != "ok" || len(group.Items) != tc.count || group.Limited != tc.limited {
				t.Fatal("scope-aware team metadata count/limit mismatch")
			}
			for _, item := range group.Items {
				if item.Kind != "team" || (tc.role == "team_admin" && item.ID != tc.team) {
					t.Fatal("search exposed another team's navigation metadata")
				}
				// The selected result must resolve through the same actual existing
				// registered-team endpoint with the same session and exact identifier.
				detail, _ := http.NewRequest(http.MethodGet, gateway.URL+"/admin/teams?view=registered&id="+item.ID+"&limit=1", nil)
				detail.Header.Set("Authorization", "Bearer "+token)
				actual, err := http.DefaultClient.Do(detail)
				if err != nil {
					t.Fatal(err)
				}
				var page store.AuthTeamPage
				err = json.NewDecoder(actual.Body).Decode(&page)
				actual.Body.Close()
				if err != nil || actual.StatusCode != 200 || page.Total != 1 || len(page.Teams) != 1 || page.Teams[0].ID != item.ID || page.Teams[0].Name != item.Title {
					t.Fatal("search and exact detail disagree")
				}
			}
		})
	}
}

func TestResourceSearchTeamProjectionFeatureAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "synthetic-full", "synthetic-reader"
	s.cfg.Auth.APIKeyPrefix = "corp_"
	for _, row := range []store.AuthTeam{
		{ID: "팀/%_!", Name: "정산 안전 팀"},
		{ID: "email-name", Name: "정산 person@example.com"},
		{ID: "corp_" + strings.Repeat("x", 43), Name: "정산 비밀 ID"},
		{ID: "long-name", Name: "정산 " + strings.Repeat("가", 257)},
		{ID: strings.Repeat("i", 513), Name: "정산 긴 ID"},
	} {
		if err := db.UpsertAuthTeam(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	for _, token := range []string{"synthetic-full", "synthetic-reader"} {
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["provider","workflow","app","skill","mcp_upstream","policy","team"]}`, token)
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 7 {
			t.Fatal("seven-kind legacy search contract failed")
		}
		group := result.Groups[6]
		if group.Status != "ok" || len(group.Items) != 1 || group.Items[0].ID != "팀/%_!" {
			t.Fatal("safe exact team identity lost or unsafe metadata exposed")
		}
		var raw map[string]json.RawMessage
		if json.Unmarshal(w.Body.Bytes(), &raw) != nil || len(raw) != 2 {
			t.Fatal("navigation envelope changed")
		}
		for _, excluded := range []string{"created_at", "updated_at", "members", "email-name", "person@example.com", "corp_", "정산 긴 ID", "정산 비밀 ID"} {
			if strings.Contains(w.Body.String(), excluded) {
				t.Fatal("search exposed excluded registration data")
			}
		}
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.access.users.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal(err)
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["team","workflow"]}`, "synthetic-reader")
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 || result.Groups[1].Status != "ok" {
			t.Fatal("runtime feature guard or independent result lost")
		}
	}
}
