package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestResourceSearchAPIKeyHTTPAuthorizationScopeAndDetail(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-api-key-search-session-secret"
	for i := range 12 {
		team := "alpha"
		if i == 10 {
			team = "beta"
		}
		if i == 11 {
			team = ""
		}
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: fmt.Sprintf("key_%02d", i), Name: fmt.Sprintf("정산 키 %02d", i), Team: team, KeyHash: fmt.Sprintf("never-selected-hash-%d", i), Owner: "private-owner", Role: "super_admin"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, role, team string
		scopes           []string
		status, count    int
		more             bool
	}{
		{"admin", "admin", "", []string{"admin:read"}, 200, 10, true},
		{"reader", "readonly_admin", "", []string{"admin:read"}, 200, 10, true},
		{"alpha", "team_admin", "alpha", []string{"admin:read"}, 200, 10, false},
		{"beta", "team_admin", "beta", []string{"admin:read"}, 200, 1, false},
		{"empty", "team_admin", "", []string{"admin:read"}, 200, 1, false},
		{"case", "team_admin", "ALPHA", []string{"admin:read"}, 200, 0, false},
		{"prefix", "team_admin", "alp", []string{"admin:read"}, 200, 0, false},
		{"write", "admin", "", []string{"admin:write"}, 403, 0, false},
		{"security", "admin", "", []string{"security:read"}, 403, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "key-search-"+tc.name, tc.role, tc.team, tc.scopes, time.Now().UTC().Add(-time.Minute))
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["api_key"]}`, token)
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("search status=%d want=%d", w.Code, tc.status)
			}
			if tc.status != 200 {
				return
			}
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 {
				t.Fatal("invalid search envelope")
			}
			g := result.Groups[0]
			if g.Status != "ok" || len(g.Items) != tc.count || g.Limited != tc.more {
				t.Fatal("scope/limit mismatch")
			}
			for _, excluded := range []string{"private-owner", "never-selected-hash", "super_admin", "key_hash"} {
				if strings.Contains(w.Body.String(), excluded) {
					t.Fatal("search leaked excluded fields")
				}
			}
			for _, item := range g.Items {
				r := httptest.NewRequest(http.MethodGet, "/admin/api-keys?"+url.Values{"id": {item.ID}}.Encode(), nil)
				r.Header.Set("Authorization", "Bearer "+token)
				detail := httptest.NewRecorder()
				s.handleAPIKeys(detail, r)
				var data struct {
					Keys []store.APIKeyPublic `json:"api_keys"`
				}
				if detail.Code != 200 || json.Unmarshal(detail.Body.Bytes(), &data) != nil || len(data.Keys) != 1 || data.Keys[0].ID != item.ID || data.Keys[0].Name != item.Title {
					t.Fatal("search and detail disagree or read inherited mutation role guard")
				}
				if strings.Contains(detail.Body.String(), "never-selected-hash") {
					t.Fatal("detail exposed hash")
				}
			}
		})
	}
}

func TestResourceSearchAPIKeyDetailValidationAndFeature(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminToken = "key-fixture-admin"
	s.cfg.Auth.AdminReadonlyToken = "key-fixture-reader"
	s.cfg.Auth.APIKeyPrefix = "corp_"
	for i, row := range []store.APIKeyRecord{{ID: "key_safe", Name: "정산 키"}, {ID: "slash/id", Name: "정산 잘못된 주소"}, {ID: "corp_" + strings.Repeat("x", 43), Name: "정산 비밀 식별자"}, {ID: "mail", Name: "정산 person@example.com"}} {
		row.KeyHash = fmt.Sprintf("secret-fixture-%d", i)
		if err := db.UpsertAPIKey(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	for _, token := range []string{"key-fixture-admin", "key-fixture-reader"} {
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["api_key"]}`, token)
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != "key_safe" {
			t.Fatal("unsafe navigation projected")
		}
		for _, q := range []string{"id=", "id=key_safe&id=key_safe", "id=a%2Fb", "id=a%00b", "id=%zz", "id=" + strings.Repeat("x", 513)} {
			r := httptest.NewRequest("GET", "/admin/api-keys?"+q, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.handleAPIKeys(w, r)
			if w.Code != 400 || strings.Contains(w.Body.String(), "key_safe") {
				t.Fatal("invalid ID fell back to key catalog or echoed input")
			}
		}
		for _, q := range []string{"id=missing", "id=KEY_SAFE", "id=key_saf"} {
			r := httptest.NewRequest("GET", "/admin/api-keys?"+q, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.handleAPIKeys(w, r)
			var data struct {
				Keys []store.APIKeyPublic `json:"api_keys"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil || len(data.Keys) != 0 {
				t.Fatal("exact ID lookup broadened")
			}
		}
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.access.users.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "feature guard"); err != nil {
			t.Fatal(err)
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["api_key"]}`, "key-fixture-reader")
		if w.Code != 200 || strings.Contains(w.Body.String(), "key_safe") || !strings.Contains(w.Body.String(), "forbidden") {
			t.Fatal("feature guard bypassed")
		}
	}
}
