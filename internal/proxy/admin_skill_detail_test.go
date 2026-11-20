package proxy

import (
	"context"
	"encoding/json"
	"io"
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

func readSkillView(t *testing.T, base, token, query string, status int) []byte {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/admin/skills"+query, nil)
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
	if response.StatusCode != status {
		t.Fatalf("status %d want %d body %s", response.StatusCode, status, body)
	}
	if query != "" && query != "?view=" && (strings.Contains(query, "view") || strings.Contains(query, "name")) && status != 401 && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("detail must not be cached")
	}
	return body
}
func TestAdminSkillExactDetailHTTP(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	_, gateway := serveAdminModelsTestStore(t, "skill-read-fixture", db)
	names := []string{"/스킬 +%2F?&#/", "스킬 +%2F?&#", " exact name ", "__proto__", strings.Repeat("😀", 1024)}
	expected := map[string]store.Skill{}
	for i, name := range names {
		sk, err := db.UpsertSkill(t.Context(), store.Skill{Name: name, Description: "same description", Version: "v1", Owner: "owner", Status: "deprecated", RiskLevel: "high", AllowedTeams: "foreign-team", AllowedModels: "model-*", AllowedTools: "tool", DailyLimit: 7, Instructions: "private instructions " + strings.Repeat("x", i), Metadata: "{\"exact\":\"metadata\"}"}, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		expected[name] = sk
	}
	before, err := db.ListSkills(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		t.Run(name[:min(len(name), 30)], func(t *testing.T) {
			body := readSkillView(t, gateway.URL, "skill-read-fixture", "?"+url.Values{"view": {"detail"}, "name": {name}}.Encode(), 200)
			var got struct {
				Skill *store.Skill `json:"skill"`
			}
			if json.Unmarshal(body, &got) != nil || got.Skill == nil || !reflect.DeepEqual(*got.Skill, expected[name]) {
				t.Fatal("exact full stored definition not preserved")
			}
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(body, &fields)
			if len(fields) != 1 || fields["skill"] == nil {
				t.Fatal("detail substituted a catalog")
			}
		})
	}
	if body := readSkillView(t, gateway.URL, "skill-read-fixture", "?view=detail&name=missing", 200); strings.TrimSpace(string(body)) != "{\"skill\":null}" {
		t.Fatalf("missing result %s", body)
	}
	for _, query := range []string{"?view=detail", "?name=x", "?view=detail&name=", "?view=other&name=x", "?view=detail&view=detail&name=x", "?view=detail&name=x&name=y", "?view=detail&name=x&status=draft", "?view=detail&name=x&run=true", "?view=%zz&name=x", "?view=detail&name=%zz", "?view=detail&name=%ED%A0%80", "?view=detail&name=x%0Ay", "?view=detail&name=" + strings.Repeat("a", 4097)} {
		body := readSkillView(t, gateway.URL, "skill-read-fixture", query, 400)
		if strings.Contains(string(body), "private instructions") || strings.Contains(string(body), "\"skills\"") {
			t.Fatal("invalid detail fell back to list")
		}
	}
	readSkillView(t, gateway.URL, "skill-read-fixture", "", 200)
	readSkillView(t, gateway.URL, "skill-read-fixture", "?view=", 200)
	body := readSkillView(t, gateway.URL, "skill-read-fixture", "?status=deprecated", 200)
	if !strings.Contains(string(body), "\"skills\"") {
		t.Fatal("legacy list changed")
	}
	after, err := db.ListSkills(t.Context(), "")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("read changed saved skills")
	}
	db.Close()
	body = readSkillView(t, gateway.URL, "skill-read-fixture", "?view=detail&name=missing", 500)
	if strings.Contains(string(body), "closed") {
		t.Fatal("storage error details leaked")
	}
}
func TestAdminSkillExactDetailReadAuthorization(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: "foreign-skill", Instructions: "authorized full instructions", AllowedTeams: "foreign-team"}, "fixture"); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "skills.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "skill-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	now := time.Now().UTC()
	for _, role := range []string{"super_admin", "readonly_admin", "team_admin"} {
		token := issueLLMScopedTestToken(t, db, server, "skill-"+role, role, "caller-team", []string{"admin:read"}, now)
		body := readSkillView(t, gateway.URL, token, "?view=detail&name=foreign-skill", 200)
		if !strings.Contains(string(body), "authorized full instructions") {
			t.Fatal("existing catalog read or instruction visibility changed")
		}
	}
	denied := issueLLMScopedTestToken(t, db, server, "skill-no-read", "developer", "caller-team", []string{"llm:invoke"}, now)
	for _, token := range []string{"", denied, "invalid-fixture"} {
		body := readSkillView(t, gateway.URL, token, "?view=detail&name=foreign-skill", 401)
		if strings.Contains(string(body), "authorized full instructions") {
			t.Fatal("unauthorized skill disclosed")
		}
	}
	legacy, legacyGateway := serveAdminModelsTestStore(t, "skill-admin-fixture", db)
	legacy.cfg.Auth.AdminReadonlyToken = "skill-readonly-fixture"
	for _, token := range []string{"skill-admin-fixture", "skill-readonly-fixture"} {
		readSkillView(t, legacyGateway.URL, token, "?view=detail&name=foreign-skill", 200)
	}
}
