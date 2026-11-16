package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestText2SQLSchemaDetailHTTPAuthorizationAndContract(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-schema-http-session-fixture"
	name := "정산/정확?%#"
	if err := db.UpsertText2SQLSchema(t.Context(), store.Text2SQLSchema{Name: name, Enabled: false, SchemaText: "private-context"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		scopes []string
		want   int
	}{
		{"reader", []string{"admin:read"}, 200}, {"writer", []string{"admin:write"}, 401}, {"routing", []string{"routing:read"}, 401}, {"security", []string{"security:read"}, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "schema-http-"+tc.name, "readonly_admin", "", tc.scopes, time.Now().UTC().Add(-time.Minute))
			request, _ := http.NewRequest(http.MethodGet, gateway.URL+"/admin/text2sql?"+url.Values{"view": {"schema"}, "name": {name}}.Encode(), nil)
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
			if response.StatusCode != tc.want || !validRequestID(response.Header.Get("X-Request-ID")) {
				t.Fatalf("HTTP scope mismatch: %d", response.StatusCode)
			}
			if strings.Contains(string(body), "private-context") {
				t.Fatal("HTTP raw projection widened")
			}
			if tc.want == 200 {
				if response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("detail is cacheable")
				}
				var result map[string]any
				if json.Unmarshal(body, &result) != nil || len(result) != 2 || result["raw_content_available"] != false {
					t.Fatal("detail envelope mismatch")
				}
				schema, ok := result["schema"].(map[string]any)
				if !ok || schema["name"] != name || schema["enabled"] != false {
					t.Fatal("exact disabled detail mismatch")
				}
				fields := text2SQLSchemaDetailOpenAPISchemas()["Text2SQLSchemaView"].(map[string]any)
				required := fields["required"].([]string)
				if len(schema) != len(required) {
					t.Fatal("OpenAPI fields mismatch")
				}
				for _, field := range required {
					if _, ok := schema[field]; !ok {
						t.Fatal("missing required field")
					}
				}
				tables, ok := schema["allowed_tables"].([]any)
				if !ok || len(tables) != 0 {
					t.Fatal("masked tables not empty array")
				}
			}
			search := resourceSearchRequest(s, `{"query":"정산","kinds":["text2sql_schema"]}`, token)
			if tc.name == "reader" && search.Code != 200 {
				t.Fatal("authorized navigation failed")
			}
			if tc.name == "writer" && search.Code != 403 {
				t.Fatal("write scope granted read")
			}
			if tc.name == "routing" || tc.name == "security" {
				if search.Code != 403 {
					t.Fatal("domain-only scope granted schema navigation")
				}
				kind := "routing_rule"
				if tc.name == "security" {
					kind = "policy"
				}
				search = resourceSearchRequest(s, `{"query":"정산","kinds":["`+kind+`","text2sql_schema"]}`, token)
				var result struct {
					Groups []resourceSearchGroup `json:"groups"`
				}
				if search.Code != 200 || json.Unmarshal(search.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[1].Status != "forbidden" || len(result.Groups[1].Items) != 0 {
					t.Fatal("mixed domain read broadened schema scope")
				}
			}
		})
	}
	request, _ := http.NewRequest(http.MethodGet, gateway.URL+"/admin/text2sql?view=schema&name=unknown", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("unauthenticated detail exposed")
	}
}

func TestText2SQLSchemaSearchProjectionFeatureAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "public-schema-full", "public-schema-reader"
	s.cfg.Auth.APIKeyPrefix = "corp_"
	for _, name := range []string{"정산 공개", "정산 person@example.com", "정산 corp_" + strings.Repeat("x", 43), "정산\u200bhidden", "정산 " + strings.Repeat("가", 513)} {
		if err := db.UpsertText2SQLSchema(t.Context(), store.Text2SQLSchema{Name: name, SchemaText: "private-only-search", AllowedTables: []string{"private-table"}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, token := range []string{"public-schema-full", "public-schema-reader"} {
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["text2sql_schema"]}`, token)
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 1 || len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != "정산 공개" {
			t.Fatal("safe schema navigation changed")
		}
		for _, hidden := range []string{"person@example.com", "corp_", "private-only-search", "private-table", "schema_text"} {
			if strings.Contains(w.Body.String(), hidden) {
				t.Fatal("search returned private data")
			}
		}
		detail := schemaDetailRequest(s, "view=schema&name="+url.QueryEscape("정산 공개"), token)
		if detail.Code != 200 {
			t.Fatal("legacy token detail rejected")
		}
		if token == "public-schema-reader" && strings.Contains(detail.Body.String(), "private-only-search") {
			t.Fatal("readonly legacy raw projection widened")
		}
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.text2sql.overview.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "guard"); err != nil {
			t.Fatal(err)
		}
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["text2sql_schema","workflow"]}`, "public-schema-reader")
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Groups) != 2 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 || result.Groups[1].Status != "ok" {
			t.Fatal("feature restriction widened or independent search lost")
		}
		// Migration visibility changes navigation only; existing legacy API stays usable.
		if schemaDetailRequest(s, "window=7d", "public-schema-reader").Code != 200 {
			t.Fatal("legacy overview changed")
		}
	}
}
