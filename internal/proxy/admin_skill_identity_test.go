package proxy

import (
	"bytes"
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

// Use the real router and a redirect-refusing HTTP client: a mutation must never
// reach a different resource after path cleaning.
func exactSkillRequest(t *testing.T, base, token, method, path string, body any, status int) []byte {
	t.Helper()
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, base+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != status {
		t.Fatalf("status=%d want=%d location=%q body=%s", res.StatusCode, status, res.Header.Get("Location"), got)
	}
	return got
}

func seedExactSkillPair(t *testing.T, db *store.SQLStore, name, alias string) store.Skill {
	t.Helper()
	for _, n := range []string{name, alias} {
		_, err := db.UpsertSkill(t.Context(), store.Skill{Name: n, Description: "original", Status: "draft", RiskLevel: "low", Instructions: "instructions for " + n}, "fixture")
		if err != nil {
			t.Fatal(err)
		}
	}
	got, found, err := db.GetSkill(t.Context(), alias)
	if err != nil || !found {
		t.Fatal("alias fixture unavailable", err)
	}
	return got
}

func assertExactSkillAlias(t *testing.T, db *store.SQLStore, before store.Skill) {
	t.Helper()
	got, found, err := db.GetSkill(t.Context(), before.Name)
	if err != nil || !found || !reflect.DeepEqual(got, before) {
		t.Fatal("another skill was changed", err)
	}
}

func TestAdminSkillByNamePreservesExactPathIdentity(t *testing.T) {
	cases := []struct{ name, suffix string }{
		{"/target/", "%2Ftarget%2F"},
		{"///", "%2F%2F%2F"},
		{"nested/../target", "nested%2F..%2Ftarget"},
		{".", "%2E"},
		{"%2Ftarget%2F", "%252Ftarget%252F"},
		{" exact name ", url.PathEscape(" exact name ")},
		{"스킬 +?&#", url.PathEscape("스킬 +?&#")},
		{strings.Repeat("a", 4097), strings.Repeat("a", 4097)},
		{"/target/", "/target/"},
		{"./target", "./target"},
		{"nested/../target", "nested/../target"},
		{"target/", "target/"},
	}
	for i, tc := range cases {
		t.Run(itoaProxy(i), func(t *testing.T) {
			db := openTestStore(t)
			t.Cleanup(func() { db.Close() })
			_, gateway := serveAdminModelsTestStore(t, "exact-admin", db)
			alias := strings.Trim(tc.name, "/")
			if alias == "" || alias == tc.name {
				alias = "target"
			}
			if alias == tc.name {
				alias = "alias"
			}
			before := seedExactSkillPair(t, db, tc.name, alias)
			path := "/admin/skills/by-name/" + tc.suffix
			data := exactSkillRequest(t, gateway.URL, "exact-admin", "GET", path, nil, 200)
			var got struct {
				Skill store.Skill `json:"skill"`
			}
			if json.Unmarshal(data, &got) != nil || got.Skill.Name != tc.name {
				t.Fatal("read selected another identity")
			}
			exactSkillRequest(t, gateway.URL, "exact-admin", "DELETE", path, nil, 200)
			if _, found, err := db.GetSkill(t.Context(), tc.name); err != nil || found {
				t.Fatal("selected identity was not deleted", err)
			}
			assertExactSkillAlias(t, db, before)
		})
	}
}

func TestAdminSkillExactPathAuthorization(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	server, gateway := serveAdminModelsTestStore(t, "exact-admin", db)
	server.cfg.Auth.AdminReadonlyToken = "exact-reader"
	before := seedExactSkillPair(t, db, "/target/", "target")
	selected, _, _ := db.GetSkill(t.Context(), "/target/")
	path := "/admin/skills/by-name/%2Ftarget%2F"
	for _, token := range []string{"", "invalid", "exact-reader"} {
		exactSkillRequest(t, gateway.URL, token, "DELETE", path, nil, 401)
	}
	exactSkillRequest(t, gateway.URL, "exact-reader", "GET", path, nil, 200)
	assertExactSkillAlias(t, db, before)
	assertExactSkillAlias(t, db, selected)
}

func TestAdminSkillDeleteDoesNotDeleteTrimmedAlias(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	_, gateway := serveAdminModelsTestStore(t, "exact-admin", db)
	before := seedExactSkillPair(t, db, "/target/", "target")
	exactSkillRequest(t, gateway.URL, "exact-admin", "DELETE", "/admin/skills/by-name/%2Ftarget%2F", nil, 200)
	if _, found, err := db.GetSkill(t.Context(), "/target/"); err != nil || found {
		t.Error("selected skill was not deleted", err)
	}
	assertExactSkillAlias(t, db, before)
}

func TestAdminSkillExactPathJWTAuthorization(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "exact-skill.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "exact-skill-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	alias := seedExactSkillPair(t, db, "/target/", "target")
	selected, _, _ := db.GetSkill(t.Context(), "/target/")
	now := time.Now().UTC()
	for _, role := range []string{"super_admin", "readonly_admin", "team_admin"} {
		token := issueLLMScopedTestToken(t, db, server, "exact-"+role, role, "caller-team", []string{"admin:read"}, now)
		for _, path := range []string{"/admin/skills/by-name/%2Ftarget%2F", "/admin/skills/by-name//target/"} {
			exactSkillRequest(t, gateway.URL, token, "GET", path, nil, 200)
			exactSkillRequest(t, gateway.URL, token, "DELETE", path, nil, 401)
		}
	}
	assertExactSkillAlias(t, db, alias)
	assertExactSkillAlias(t, db, selected)
	token := issueLLMScopedTestToken(t, db, server, "exact-write", "super_admin", "caller-team", []string{"admin:read", "admin:write"}, now)
	exactSkillRequest(t, gateway.URL, token, "DELETE", "/admin/skills/by-name//target/", nil, 200)
	if _, found, err := db.GetSkill(t.Context(), "/target/"); err != nil || found {
		t.Fatal("authorized delete did not remove selected identity", err)
	}
	assertExactSkillAlias(t, db, alias)
}

func TestAdminSkillMissingExactPathDoesNotFallBackToAlias(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	_, gateway := serveAdminModelsTestStore(t, "exact-admin", db)
	alias, err := db.UpsertSkill(t.Context(), store.Skill{Name: "target", Description: "keep"}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	path := "/admin/skills/by-name/%2Ftarget%2F"
	exactSkillRequest(t, gateway.URL, "exact-admin", "GET", path, nil, 404)
	exactSkillRequest(t, gateway.URL, "exact-admin", "DELETE", path, nil, 200)
	assertExactSkillAlias(t, db, alias)
}
