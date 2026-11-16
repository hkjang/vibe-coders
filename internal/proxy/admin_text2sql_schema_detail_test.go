package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func schemaDetailRequest(s *Server, query, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/admin/text2sql?"+query, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.handleText2SQLAdmin(w, r)
	return w
}

func TestText2SQLSchemaSearchAndDetailScope(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-schema-navigation-session"
	for _, team := range []store.AuthTeam{{ID: "alpha", Name: "운영 팀"}, {ID: "beta", Name: "다른 팀"}} {
		if err := db.UpsertAuthTeam(t.Context(), team); err != nil {
			t.Fatal(err)
		}
	}
	for _, schema := range []store.Text2SQLSchema{
		{Name: "정산 공용", Enabled: true, IsDefault: true},
		{Name: "정산/알파?%#", Team: "alpha", Enabled: false},
		{Name: "정산 이름 연결", Team: "운영 팀", Enabled: true},
		{Name: "정산 베타", Team: "beta", Enabled: true},
		{Name: "정산 잘못된 소속", Team: " alpha", Enabled: true},
	} {
		schema.SchemaText = "private-schema-context"
		schema.AllowedTables = []string{"private-table"}
		schema.Dialect = "postgres"
		if err := db.UpsertText2SQLSchema(t.Context(), schema); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, role, team string
		count            int
	}{
		{"admin", "admin", "", 5}, {"readonly", "readonly_admin", "", 5}, {"alpha", "team_admin", "alpha", 3},
		{"empty", "team_admin", "", 1}, {"missing", "team_admin", "missing", 1}, {"case", "team_admin", "ALPHA", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "schema-search-"+tc.name, tc.role, tc.team, []string{"admin:read"}, time.Now().UTC().Add(-time.Minute))
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["text2sql_schema"]}`, token)
			var result struct {
				Groups []resourceSearchGroup `json:"groups"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || result.Groups[0].Status != "ok" || len(result.Groups[0].Items) != tc.count {
				t.Fatalf("search scope: status=%d count=%d", w.Code, len(result.Groups))
			}
			for _, forbidden := range []string{"private-schema-context", "private-table", "schema_text", "allowed_tables", "team", "dialect"} {
				if strings.Contains(w.Body.String(), forbidden) {
					t.Fatal("search returned non-navigation data")
				}
			}
			overview := schemaDetailRequest(s, "window=7d", token)
			var old struct {
				Schemas []store.Text2SQLSchema `json:"schemas"`
			}
			if overview.Code != 200 || json.Unmarshal(overview.Body.Bytes(), &old) != nil {
				t.Fatal("existing overview failed")
			}
			allowed := map[string]bool{}
			for _, sc := range old.Schemas {
				allowed[sc.Name] = true
			}
			for _, item := range result.Groups[0].Items {
				if !allowed[item.ID] {
					t.Fatal("search exceeded existing overview scope")
				}
				q := url.Values{"view": {"schema"}, "name": {item.ID}}.Encode()
				detail := schemaDetailRequest(s, q, token)
				var body struct {
					Schema store.Text2SQLSchema `json:"schema"`
					Raw    bool                 `json:"raw_content_available"`
				}
				if detail.Code != 200 || detail.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(detail.Body.Bytes(), &body) != nil || body.Schema.Name != item.ID {
					t.Fatalf("exact detail mismatch: %d", detail.Code)
				}
				if tc.role != "admin" && (body.Raw || strings.Contains(detail.Body.String(), "private-schema-context") || strings.Contains(detail.Body.String(), "private-table")) {
					t.Fatal("sensitive detail widened permission")
				}
				if tc.role == "admin" && (!body.Raw || body.Schema.SchemaText != "private-schema-context") {
					t.Fatal("authorized context lost")
				}
			}
			if tc.role == "team_admin" {
				w = schemaDetailRequest(s, url.Values{"view": {"schema"}, "name": {"정산 베타"}}.Encode(), token)
				if w.Code != 404 || strings.Contains(w.Body.String(), "정산 베타") {
					t.Fatal("foreign detail disclosed")
				}
			}
		})
	}
}

func TestText2SQLSchemaDetailRejectsInvalidAndMissingNames(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	if err := db.UpsertText2SQLSchema(t.Context(), store.Text2SQLSchema{Name: "정산/정확?%#", SchemaText: "private-context", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"view=schema", "view=schema&name=", "view=schema&name=%zz", "view=schema&name=a&name=b", "view=schema&name=a&window=7d", "view=schema&name=a%00b", "view=schema&name=%20space", "view=schema&name=" + strings.Repeat("a", 513), "view=schema&name=a%EF%BB%BFb"} {
		w := schemaDetailRequest(s, q, "")
		if w.Code != 400 || strings.Contains(w.Body.String(), "private-context") {
			t.Fatalf("invalid detail became overview: %d", w.Code)
		}
	}
	for _, name := range []string{"missing", "정산/정확", "' OR 1=1 --"} {
		w := schemaDetailRequest(s, url.Values{"view": {"schema"}, "name": {name}}.Encode(), "")
		if w.Code != 404 {
			t.Fatalf("missing name: %d", w.Code)
		}
	}
	audit, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audit) != 0 {
		t.Fatal("detail produced mutation audit")
	}
}
