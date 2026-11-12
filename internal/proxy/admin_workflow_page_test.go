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

func readWorkflowView(t *testing.T, base, token, query string, status int) []byte {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/admin/workflows"+query, nil)
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
		t.Fatalf("workflow status = %d; want %d", response.StatusCode, status)
	}
	if status == 200 && strings.Contains(query, "view=") && !strings.HasPrefix(query, "?view=&") && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("workflow views must not be cached")
	}
	return body
}

func TestAdminWorkflowPageHTTPProjectionDetailAndLegacy(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "workflow-admin-fixture")
	for index := range 32 {
		if err := db.UpsertWorkflow(t.Context(), store.Workflow{ID: fmt.Sprintf("wf-%02d", index), Name: fmt.Sprintf("업무 %02d", index),
			Enabled: index%2 == 0, AllowedTeams: "execution-only-team", CreatedAt: "2026-11-12T00:00:00Z",
			Steps: []store.WorkflowStep{{Name: "질문", Type: "chat", Note: "definition-only-marker"}}}); err != nil {
			t.Fatal(err)
		}
	}
	var page store.WorkflowPage
	body := readWorkflowView(t, gateway.URL, "workflow-admin-fixture", "?view=page&limit=10&offset=20&sort=id:asc", 200)
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 32 || page.Limit != 10 || page.Offset != 20 || len(page.Workflows) != 10 || page.Workflows[0].ID != "wf-20" || page.Summary != (store.WorkflowSummary{Total: 32, Enabled: 16}) {
		t.Fatal("HTTP page contract mismatch")
	}
	if strings.Contains(string(body), "definition-only-marker") || strings.Contains(string(body), `"steps"`) {
		t.Fatal("list leaked a definition")
	}
	body = readWorkflowView(t, gateway.URL, "workflow-admin-fixture", "?view=page&q=wf-31&status=disabled", 200)
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Workflows) != 1 || page.Summary.Total != 32 {
		t.Fatal("HTTP filter/count mismatch")
	}
	for _, id := range []string{"wf-31", "exact / & ? # ", strings.Repeat("x", 4096)} {
		if id != "wf-31" {
			if err := db.UpsertWorkflow(t.Context(), store.Workflow{ID: id, Name: "정확한 식별자", Steps: []store.WorkflowStep{{Type: "approval"}}}); err != nil {
				t.Fatal(err)
			}
		}
		var detail struct {
			Workflow *store.Workflow `json:"workflow"`
		}
		body := readWorkflowView(t, gateway.URL, "workflow-admin-fixture", "?view=detail&id="+url.QueryEscape(id), 200)
		if err := json.Unmarshal(body, &detail); err != nil {
			t.Fatal(err)
		}
		original, found, err := db.GetWorkflow(t.Context(), id)
		if err != nil || !found || detail.Workflow == nil || !reflect.DeepEqual(*detail.Workflow, original) {
			t.Fatal("exact detail differs from stored definition")
		}
	}
	if strings.TrimSpace(string(readWorkflowView(t, gateway.URL, "workflow-admin-fixture", "?view=detail&id=wf-3", 200))) != `{"workflow":null}` {
		t.Fatal("missing detail must not select a partial ID")
	}
	var legacy struct {
		Workflows []store.Workflow `json:"workflows"`
	}
	for _, query := range []string{"", "?q=missing&limit=1", "?view=&limit=1"} {
		if err := json.Unmarshal(readWorkflowView(t, gateway.URL, "workflow-admin-fixture", query, 200), &legacy); err != nil {
			t.Fatal(err)
		}
		if len(legacy.Workflows) != 34 {
			t.Fatal("legacy unpaged list changed")
		}
	}
}

func TestAdminWorkflowPageHTTPValidation(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	for _, query := range []string{
		"?view=unknown", "?view=%zz", "?view=page&view=page", "?view=page&q=a&q=b", "?view=page&q=%zz",
		"?view=page&limit=0", "?view=page&limit=101", "?view=page&limit=", "?view=page&offset=-1", "?view=page&offset=1000001",
		"?view=page&status=other", "?view=page&id=wf", "?view=page&sort=name", "?view=page&sort=steps:asc",
		"?view=page&sort=id:asc,id:desc", "?view=page&sort=id:asc,name:asc,enabled:desc,created_at:asc",
		"?view=page&q=a%0Ab", "?view=page&q=" + url.QueryEscape(strings.Repeat("한", 201)),
		"?view=detail", "?view=detail&id=", "?view=detail&id=a%0Ab", "?view=detail&id=a&id=b",
		"?view=detail&id=a&limit=1", "?view=detail&id=a&q=", "?view=detail&id=" + strings.Repeat("x", 4097),
	} {
		body := readWorkflowView(t, gateway.URL, "", query, 400)
		if !strings.Contains(string(body), `"invalid_workflow_query"`) {
			t.Fatal("missing stable validation error code")
		}
	}
}

func TestAdminWorkflowPageHTTPExistingReadAuthorization(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	if err := db.UpsertWorkflow(t.Context(), store.Workflow{ID: "foreign-execution", Name: "운영 정의", AllowedTeams: "foreign-team", Steps: []store.WorkflowStep{{Type: "chat"}}}); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "workflow-page.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "workflow-legacy-fixture")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "workflow-jwt-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	now := time.Now().UTC()
	for _, role := range []string{"super_admin", "readonly_admin", "team_admin"} {
		token := issueLLMScopedTestToken(t, db, server, "workflow-"+role, role, "caller-team", []string{"admin:read"}, now)
		for _, query := range []string{"", "?view=page", "?view=detail&id=foreign-execution"} {
			body := readWorkflowView(t, gateway.URL, token, query, 200)
			if !strings.Contains(string(body), `"foreign-execution"`) {
				t.Fatal("execution team policy incorrectly became an admin visibility restriction")
			}
		}
	}
	denied := issueLLMScopedTestToken(t, db, server, "workflow-no-read", "developer", "caller-team", []string{"llm:invoke"}, now)
	for _, token := range []string{"", denied, "invalid-fixture"} {
		for _, query := range []string{"", "?view=page", "?view=detail&id=foreign-execution"} {
			body := readWorkflowView(t, gateway.URL, token, query, 401)
			if strings.Contains(string(body), "foreign-execution") {
				t.Fatal("unauthorized definition disclosed")
			}
		}
	}
	legacyServer, legacyGateway := serveAdminModelsTestStore(t, "workflow-legacy-fixture", db)
	legacyServer.cfg.Auth.AdminReadonlyToken = "workflow-readonly-fixture"
	for _, token := range []string{"workflow-legacy-fixture", "workflow-readonly-fixture"} {
		for _, query := range []string{"?view=page", "?view=detail&id=foreign-execution"} {
			readWorkflowView(t, legacyGateway.URL, token, query, 200)
		}
	}
}
