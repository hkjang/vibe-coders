package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func readTraceRuns(t *testing.T, base, token, query string, status int) []byte {
	t.Helper()
	path := "/admin/traces/trace-related"
	if query != "" {
		path += "/runs"
	}
	req, err := http.NewRequest(http.MethodGet, base+path+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != status {
		t.Fatalf("status %d want %d", res.StatusCode, status)
	}
	if query != "" && res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("metadata cached")
	}
	return body
}
func TestTraceRelatedRunsProjectionContractAndLegacy(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "trace-admin-test")
	if err := db.UpsertWorkflow(t.Context(), store.Workflow{ID: "public-workflow", Name: "사용자 person@example.com", Enabled: true, Steps: []store.WorkflowStep{{Type: "chat", Note: "private-prompt"}}}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordWorkflowRun(t.Context(), store.WorkflowRun{ID: "wf-run", WorkflowID: "public-workflow", TraceID: "trace-related", Status: "ok", UserID: "private-owner", Team: "private-team", LatencyMS: 20, CostKRW: 2, ErrorClass: "private-error"}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordAIAppRun(t.Context(), store.AIAppRun{ID: "app-run", AppID: "public-app", TraceID: "trace-related", Status: "private-status", UserID: "private-owner", Team: "private-team", LatencyMS: -1, CostKRW: -1, InputHash: "private-hash", OutputSummary: "private-output", ErrorClass: "private-error"}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"workflow", "app"} {
		body := readTraceRuns(t, gateway.URL, "trace-admin-test", "?kind="+kind, 200)
		for _, secret := range []string{"private-owner", "private-team", "private-error", "private-hash", "private-output", "private-status", "private-prompt", "person@example.com"} {
			if strings.Contains(string(body), secret) {
				t.Fatal("metadata disclosed", secret)
			}
		}
		var page traceRelatedRunPage
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatal(err)
		}
		if page.Version != 1 || page.Kind != kind || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ReceiptAvailable {
			t.Fatalf("invalid page %+v", page)
		}
		if kind == "workflow" && page.Items[0].ResourceName != nil {
			t.Fatal("PII name exposed")
		}
		if kind == "app" && (page.Items[0].LatencyMS != nil || page.Items[0].CostKRW != nil || page.Items[0].Status != "unknown") {
			t.Fatal("invalid metric/status projection")
		}
	}
	body := readTraceRuns(t, gateway.URL, "trace-admin-test", "", 200)
	if !strings.Contains(string(body), "private-output") {
		t.Fatal("legacy full admin export changed")
	}
	for _, query := range []string{"?view=", "?view=related-runs", "?kind=other", "?kind=app&kind=workflow", "?kind=app&limit=0", "?kind=app&offset=01", "?kind=app&unexpected=x", "?kind=app&offset=1000001", "?kind=app&offset=%ZZ", "?kind=app&extra=x;y"} {
		readTraceRuns(t, gateway.URL, "trace-admin-test", query, 400)
	}
	readTraceRuns(t, gateway.URL, "", "?kind=app", 401)
}
func TestTraceRelatedRunsTeamScopeAndOwnReceipt(t *testing.T) {
	db := openTestStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Add(-time.Minute)
	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: "team-a", Name: "개발팀"}); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "trace-runs.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "trace-related-fixture"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	token := issueLLMScopedTestToken(t, db, server, "owner-a", "team_admin", "team-a", []string{"admin:read"}, now)
	for _, kind := range []string{"workflow", "app"} {
		for _, row := range []struct{ id, owner, team string }{{"own", "owner-a", "개발팀"}, {"colleague", "owner-b", "team-a"}, {"foreign", "owner-a", "team-b"}, {"padded", "owner-a", "개발팀 "}} {
			if kind == "workflow" {
				err = db.RecordWorkflowRun(ctx, store.WorkflowRun{ID: row.id, WorkflowID: "wf", UserID: row.owner, Team: row.team, TraceID: "trace-related", Status: "ok"})
			} else {
				err = db.RecordAIAppRun(ctx, store.AIAppRun{ID: row.id, AppID: "app", UserID: row.owner, Team: row.team, TraceID: "trace-related", Status: "ok"})
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		body := readTraceRuns(t, gateway.URL, token, "?kind="+kind, 200)
		var page traceRelatedRunPage
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatal(err)
		}
		if page.Total != 2 || len(page.Items) != 2 {
			t.Fatal("scope must precede count", string(body))
		}
		for _, item := range page.Items {
			if item.ID == nil || item.ReceiptAvailable != (*item.ID == "own") {
				t.Fatal("receipt ownership mismatch")
			}
		}
	}
	empty := issueLLMScopedTestToken(t, db, server, "empty", "team_admin", "", []string{"admin:read"}, now)
	body := readTraceRuns(t, gateway.URL, empty, "?kind=app", 200)
	var page traceRelatedRunPage
	_ = json.Unmarshal(body, &page)
	if page.Total != 0 || len(page.Items) != 0 {
		t.Fatal("empty team widened")
	}
	denied := issueLLMScopedTestToken(t, db, server, "denied", "member", "team-a", []string{}, now)
	readTraceRuns(t, gateway.URL, denied, "?kind=app", 401)
}

func TestTraceRelatedRunsPathAndMethodIsolation(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "trace-admin-test")
	for _, tc := range []struct {
		path, method string
		status       int
		metadata     bool
	}{
		{"/admin/traces/runs", "GET", 200, false},
		{"/admin/traces/runs/runs?kind=app", "GET", 200, true},
		{"/admin/traces/trace-related/runs", "GET", 400, true},
		{"/admin/traces/" + strings.Repeat("x", 1025) + "/runs?kind=app", "GET", 400, true},
		{"/admin/traces/trace-related/runs?kind=app", "POST", 405, true},
		{"/admin/traces/trace-related/runs?kind=app", "HEAD", 405, true},
		{"/admin/traces/nested/trace/runs?kind=app", "GET", 400, true},
	} {
		req, _ := http.NewRequest(tc.method, gateway.URL+tc.path, nil)
		req.Header.Set("Authorization", "Bearer trace-admin-test")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != tc.status {
			t.Fatalf("%s: %d", tc.path, res.StatusCode)
		}
		if tc.metadata && res.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("metadata cached")
		}
		if tc.metadata && strings.Contains(string(body), "workflow_runs") {
			t.Fatal("legacy export leaked into metadata read")
		}
	}
	// An older server's single-resource parser rejects the new nested path. It
	// cannot silently ignore a query flag and return the old raw trace export.
	if _, valid := adminTracePathID("/admin/traces/trace-related/runs", "/admin/traces/", ""); valid {
		t.Fatal("old route accepts metadata subpath")
	}
}
