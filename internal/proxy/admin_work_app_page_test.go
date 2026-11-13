package proxy

import (
	"context"
	"encoding/json"
	"fmt"
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

func readWorkAppView(t *testing.T, base, token, query string, status int) []byte {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/admin/apps"+query, nil)
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
		t.Fatalf("app query %q status = %d; want %d", query, response.StatusCode, status)
	}
	if status == 200 && strings.Contains(query, "view=") && !strings.HasPrefix(query, "?view=&") && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("app views must not be cached")
	}
	return body
}

func TestAdminWorkAppPageHTTPProjectionDetailAndLegacy(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "app-admin-fixture")
	for index := range 32 {
		if err := db.CreateWorkApp(t.Context(), store.WorkApp{ID: fmt.Sprintf("wf-%02d", index), Title: fmt.Sprintf("업무 %02d", index),
			Status: []string{"active", "archived"}[index%2], AllowedTeams: "execution-only-team", CreatedAt: "2026-11-12T00:00:00Z",
			Components: []store.AppComponent{{Label: "질문", Kind: "model", Ref: "definition-only-marker"}}}); err != nil {
			t.Fatal(err)
		}
	}
	var page store.WorkAppPage
	body := readWorkAppView(t, gateway.URL, "app-admin-fixture", "?view=page&limit=10&offset=20&sort=id:asc", 200)
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 32 || page.Limit != 10 || page.Offset != 20 || len(page.Apps) != 10 || page.Apps[0].ID != "wf-20" || page.Summary != (store.WorkAppSummary{Total: 32, Active: 16, Archived: 16}) {
		t.Fatal("HTTP page contract mismatch")
	}
	if strings.Contains(string(body), "definition-only-marker") || strings.Contains(string(body), `"components"`) {
		t.Fatal("list leaked a definition")
	}
	body = readWorkAppView(t, gateway.URL, "app-admin-fixture", "?view=page&q=wf-31&status=archived", 200)
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Apps) != 1 || page.Summary.Total != 32 {
		t.Fatal("HTTP filter/count mismatch")
	}
	for _, id := range []string{"wf-31", "exact / & ? # ", strings.Repeat("x", 4096)} {
		if id != "wf-31" {
			if err := db.CreateWorkApp(t.Context(), store.WorkApp{ID: id, Title: "정확한 식별자", Components: []store.AppComponent{{Kind: "model", Ref: "public"}}}); err != nil {
				t.Fatal(err)
			}
		}
		var detail struct {
			WorkApp *store.WorkApp `json:"app"`
		}
		body := readWorkAppView(t, gateway.URL, "app-admin-fixture", "?view=detail&id="+url.QueryEscape(id), 200)
		if err := json.Unmarshal(body, &detail); err != nil {
			t.Fatal(err)
		}
		original, found, err := db.GetWorkApp(t.Context(), id)
		if err != nil || !found || detail.WorkApp == nil || !reflect.DeepEqual(*detail.WorkApp, original) {
			t.Fatal("exact detail differs from stored definition")
		}
	}
	if strings.TrimSpace(string(readWorkAppView(t, gateway.URL, "app-admin-fixture", "?view=detail&id=wf-3", 200))) != `{"app":null}` {
		t.Fatal("missing detail must not select a partial ID")
	}
	var legacy struct {
		Apps []store.WorkApp `json:"apps"`
	}
	for _, query := range []string{"", "?q=missing&limit=1", "?view=&limit=1"} {
		if err := json.Unmarshal(readWorkAppView(t, gateway.URL, "app-admin-fixture", query, 200), &legacy); err != nil {
			t.Fatal(err)
		}
		if len(legacy.Apps) != 34 {
			t.Fatal("legacy unpaged list changed")
		}
	}
}

func TestAdminWorkAppPageHTTPValidation(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	for _, query := range []string{
		"?view=unknown", "?view=%zz", "?view=page&view=page", "?view=page&q=a&q=b", "?view=page&q=%zz",
		"?view=&view=page", "?view=&view=", "?view=%ff",
		"?view=page&limit=0", "?view=page&limit=101", "?view=page&limit=", "?view=page&offset=-1", "?view=page&offset=1000001",
		"?view=page&status=other", "?view=page&id=wf", "?view=page&sort=title", "?view=page&sort=components:asc",
		"?view=page&sort=id:asc,id:desc", "?view=page&sort=id:asc,title:asc,status:desc,created_at:asc",
		"?view=page&q=a%0Ab", "?view=page&q=" + url.QueryEscape(strings.Repeat("한", 201)),
		"?view=detail", "?view=detail&id=", "?view=detail&id=a%0Ab", "?view=detail&id=a&id=b",
		"?view=detail&id=a&limit=1", "?view=detail&id=a&q=", "?view=detail&id=" + strings.Repeat("x", 4097),
	} {
		body := readWorkAppView(t, gateway.URL, "", query, 400)
		if !strings.Contains(string(body), `"invalid_app_query"`) {
			t.Fatal("missing stable validation error code")
		}
	}
}

func TestAdminWorkAppPageHTTPExistingReadAuthorization(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	if err := db.CreateWorkApp(t.Context(), store.WorkApp{ID: "foreign-execution", Title: "운영 정의", AllowedTeams: "foreign-team", Components: []store.AppComponent{{Kind: "model", Ref: "public"}}}); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "app-page.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "app-legacy-fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "app-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	now := time.Now().UTC()
	for _, role := range []string{"super_admin", "readonly_admin", "team_admin"} {
		token := issueLLMScopedTestToken(t, db, server, "app-"+role, role, "caller-team", []string{"admin:read"}, now)
		for _, query := range []string{"", "?view=page", "?view=detail&id=foreign-execution"} {
			body := readWorkAppView(t, gateway.URL, token, query, 200)
			if !strings.Contains(string(body), `"foreign-execution"`) {
				t.Fatal("execution team policy incorrectly became an admin visibility restriction")
			}
		}
	}
	denied := issueLLMScopedTestToken(t, db, server, "app-no-read", "developer", "caller-team", []string{"llm:invoke"}, now)
	for _, token := range []string{"", denied, "invalid-fixture"} {
		for _, query := range []string{"", "?view=page", "?view=detail&id=foreign-execution"} {
			body := readWorkAppView(t, gateway.URL, token, query, 401)
			if strings.Contains(string(body), "foreign-execution") {
				t.Fatal("unauthorized definition disclosed")
			}
		}
	}
	legacyServer, legacyGateway := serveAdminModelsTestStore(t, "app-legacy-fixture", db)
	legacyServer.cfg.Auth.AdminReadonlyToken = "app-readonly-fixture"
	for _, token := range []string{"app-legacy-fixture", "app-readonly-fixture"} {
		for _, query := range []string{"?view=page", "?view=detail&id=foreign-execution"} {
			readWorkAppView(t, legacyGateway.URL, token, query, 200)
		}
	}
}
