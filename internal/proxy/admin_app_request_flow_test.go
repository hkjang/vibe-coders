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
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

type appFlowHTTPFixture struct {
	server *Server
	db     *store.SQLStore
	url    string
	at     time.Time
}

func newAppFlowHTTPFixture(t *testing.T) appFlowHTTPFixture {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "synthetic-flow.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "public-synthetic-flow-jwt"
	cfg.Auth.APIKeyPrefix = "flow_private_"
	s, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(s.Routes())
	t.Cleanup(gateway.Close)
	return appFlowHTTPFixture{s, db, gateway.URL, time.Date(2026, 4, 1, 2, 3, 4, 123456789, time.UTC)}
}

func (f appFlowHTTPFixture) token(t *testing.T, subject, role, team string, scopes ...string) string {
	t.Helper()
	return issueLLMScopedTestToken(t, f.db, f.server, subject, role, team, scopes, time.Now().UTC())
}

func (f appFlowHTTPFixture) path(id string, at time.Time) string {
	return "/admin/app/request-flow?" + url.Values{
		"request_ref": {appRequestFlowReference(f.server.secrets.Load(), id)},
		"created_at":  {at.UTC().Format(appRequestTimestampLayout)},
	}.Encode()
}

func (f appFlowHTTPFixture) get(t *testing.T, token, method, path string) (int, []byte) {
	t.Helper()
	r, err := http.NewRequest(method, f.url+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache control=%q", got)
	}
	return response.StatusCode, body
}

func (f appFlowHTTPFixture) seed(t *testing.T, id, key string, at time.Time, tools []store.ToolInvocation) {
	t.Helper()
	err := f.db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{ID: id, TraceID: "private-trace", APIKeyID: key, Method: "POST", Model: "public-model", Provider: "public-provider", StatusCode: 200, LatencyMS: 0, CreatedAt: at, Error: "private-root-error", BodyRaw: "private-request-body", RequestHeadersJSON: "private-header"},
		Prompts: []store.PromptLog{{ID: id + "-prompt", RequestID: id, Role: "user", ContentText: "private-prompt-original", RedactedText: "private-prompt-projection", CreatedAt: at}}, Tools: tools,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestAppRequestFlowHTTPPrivacyAndNanoCompatibility(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	token := f.token(t, "flow-super", "super_admin", "", "admin:read")
	const id = "private-request-id"
	credential := "flow_private_" + strings.Repeat("A", 43)
	f.seed(t, id, "", f.at, []store.ToolInvocation{
		{ID: "private-tool-id", RequestID: id, ToolName: "lookup", ServerLabel: "catalog", Source: "call", IsMCP: true, IsError: true, ArgHash: "private-argument-hash", CreatedAt: f.at.Add(-1500 * time.Millisecond)},
		{ID: "private-secret-tool-id", RequestID: id, ToolName: credential, Source: "call", CreatedAt: f.at},
		{ID: "private-definition-id", RequestID: id, ToolName: "do-not-show-definition", Source: "definition", CreatedAt: f.at},
	})
	if err := f.db.InsertText2SQLSpans(t.Context(), []store.Text2SQLSpan{{ID: "private-sql-id", RequestID: id, Stage: "sql_validate", Status: "skipped", LatencyMS: 17, RejectReason: "private-reject-reason", Detail: "private-sql-detail", InputHash: "private-input-hash", OutputHash: "private-output-hash", CreatedAt: f.at.Add(2 * time.Millisecond)}}); err != nil {
		t.Fatal(err)
	}
	rawPermission := httptest.NewRequest("GET", "/", nil)
	rawPermission.Header.Set("Authorization", "Bearer "+token)
	if !f.server.canViewRawPrompts(rawPermission) {
		t.Fatal("fixture must exercise raw-privileged caller")
	}
	status, body := f.get(t, token, "GET", f.path(id, f.at))
	if status != 200 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var result appRequestFlowResponse
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result.CreatedAt != "2026-04-01T02:03:04.123456789Z" || result.FlowVersion != 1 || len(result.Spans) != 4 {
		t.Fatalf("response=%+v", result)
	}
	root := result.Spans[0]
	if root.Kind != "request" || root.ParentRef != nil || root.DurationMS == nil || *root.DurationMS != 0 {
		t.Fatalf("root=%+v", root)
	}
	if result.Spans[1].Kind != "mcp_tool" || result.Spans[1].Name != "catalog.lookup" || result.Spans[1].Status != "error" || result.Spans[1].DurationMS != nil || result.Spans[1].OffsetMS == nil || *result.Spans[1].OffsetMS != -1500 {
		t.Fatalf("tool=%+v", result.Spans[1])
	}
	if result.Spans[3].Name != "SQL 검증" || result.Spans[3].Status != "skipped" {
		t.Fatalf("sql=%+v", result.Spans[3])
	}
	if result.Coverage.Tools.Omitted != 1 || result.Coverage.Tools.Truncated {
		t.Fatalf("coverage=%+v", result.Coverage)
	}
	seen := map[string]bool{}
	for i, span := range result.Spans {
		if seen[span.SpanRef] || len(span.SpanRef) != 48 {
			t.Fatalf("invalid span ref=%q", span.SpanRef)
		}
		seen[span.SpanRef] = true
		if i > 0 && (span.ParentRef == nil || *span.ParentRef != root.SpanRef) {
			t.Fatal("broken parent")
		}
	}
	assertLLMExternalBody(t, body, id, "private-trace", "private-root-error", "private-request-body", "private-header", "private-prompt-original", "private-prompt-projection", "private-tool-id", "private-secret-tool-id", credential, "private-definition-id", "do-not-show-definition", "private-argument-hash", "private-sql-id", "private-reject-reason", "private-sql-detail", "private-input-hash", "private-output-hash")
	// This is the existing opaque reference contract, not a replacement handle.
	if result.RequestRef != f.server.appRequestRefSnapshot()(id) {
		t.Fatal("existing request reference compatibility changed")
	}
	if status, _ := f.get(t, token, "GET", f.path(id, f.at.Add(time.Nanosecond))); status != 404 {
		t.Fatalf("nanos mismatch status=%d", status)
	}
	oldPath := f.path(id, f.at)
	rotated, err := secret.New("public-synthetic-rotated-secret")
	if err != nil {
		t.Fatal(err)
	}
	f.server.secrets.Store(rotated)
	if status, _ := f.get(t, token, "GET", oldPath); status != 404 {
		t.Fatalf("rotated ref status=%d", status)
	}
}

func TestAppRequestFlowHTTPParametersAndAuthorization(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	token := f.token(t, "flow-read", "super_admin", "", "admin:read")
	wrongScope := f.token(t, "flow-wrong-scope", "super_admin", "", "security:read")
	f.seed(t, "flow-query", "", f.at, nil)
	valid := f.path("flow-query", f.at)
	for name, path := range map[string]string{
		"missing": "/admin/app/request-flow", "extra": valid + "&request_id=raw-id", "duplicate-ref": valid + "&request_ref=raw-id", "duplicate-time": valid + "&created_at=" + url.QueryEscape(f.at.Format(appRequestTimestampLayout)),
		"raw-id":       strings.Replace(valid, appRequestFlowReference(f.server.secrets.Load(), "flow-query"), "flow-query", 1),
		"milliseconds": strings.Replace(valid, "123456789", "123", 1), "wrong-zone": strings.Replace(valid, "789Z", "789%2B00%3A00", 1),
		"invalid-date": strings.Replace(valid, "2026-04-01", "2026-02-30", 1), "bad-escape": valid + "&bad=%zz",
	} {
		t.Run(name, func(t *testing.T) {
			if status, _ := f.get(t, token, "GET", path); status != 400 {
				t.Fatalf("status=%d", status)
			}
		})
	}
	for name, credential := range map[string]string{"missing-auth": "", "bad-auth": "not-a-jwt", "scope": wrongScope} {
		t.Run(name, func(t *testing.T) {
			if status, _ := f.get(t, credential, "GET", valid); status != 401 {
				t.Fatalf("status=%d", status)
			}
		})
	}
	if status, _ := f.get(t, token, "POST", valid); status != 405 {
		t.Fatalf("method status=%d", status)
	}
}

func TestAppRequestFlowHTTPUniformUnavailableAndCaps(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	for _, team := range []store.AuthTeam{{ID: "flow-team-a", Name: "Team A"}, {ID: "flow-team-b", Name: "Team B"}} {
		if err := f.db.UpsertAuthTeam(t.Context(), team); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "flow-key", Name: "flow key", KeyHash: "public-hash", Team: "Team A", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	teamA := f.token(t, "flow-team-a-user", "team_admin", "flow-team-a", "admin:read")
	teamB := f.token(t, "flow-team-b-user", "team_admin", "flow-team-b", "admin:read")
	emptyTeam := f.token(t, "flow-team-empty-user", "team_admin", "", "admin:read")
	f.seed(t, "flow-visible", "flow-key", f.at, nil)
	if status, _ := f.get(t, teamA, "GET", f.path("flow-visible", f.at)); status != 200 {
		t.Fatalf("own team=%d", status)
	}
	status, absent := f.get(t, teamA, "GET", f.path("flow-absent", f.at))
	if status != 404 {
		t.Fatalf("missing=%d", status)
	}
	for _, credential := range []string{teamB, emptyTeam} {
		status, body := f.get(t, credential, "GET", f.path("flow-visible", f.at))
		if status != 404 || string(body) != string(absent) {
			t.Fatalf("scope not uniform: %d %s", status, body)
		}
	}
	// All 201 global candidates consume the budget, including unrelated keys;
	// the response reveals neither the reason nor the count.
	for i := 0; i < 200; i++ {
		f.seed(t, fmt.Sprintf("flow-collision-%03d", i), "other-key", f.at, nil)
	}
	status, body := f.get(t, teamA, "GET", f.path("flow-visible", f.at))
	if status != 404 || string(body) != string(absent) {
		t.Fatalf("cap not uniform: %d %s", status, body)
	}
}

func TestAppRequestFlowHTTPChildCapsBeforeFiltering(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	token := f.token(t, "flow-child-cap", "super_admin", "", "admin:read")
	tools := make([]store.ToolInvocation, 101)
	sqlSpans := make([]store.Text2SQLSpan, 101)
	for i := range tools {
		tools[i] = store.ToolInvocation{ID: fmt.Sprintf("tool-%03d", i), RequestID: "flow-child-cap", ToolName: "definition", Source: "definition", CreatedAt: f.at}
		sqlSpans[i] = store.Text2SQLSpan{ID: fmt.Sprintf("sql-%03d", i), RequestID: "flow-child-cap", Stage: "classify", Status: "ok", CreatedAt: f.at}
	}
	f.seed(t, "flow-child-cap", "", f.at, tools)
	if err := f.db.InsertText2SQLSpans(t.Context(), sqlSpans); err != nil {
		t.Fatal(err)
	}
	status, body := f.get(t, token, "GET", f.path("flow-child-cap", f.at))
	var result appRequestFlowResponse
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if status != 200 || len(result.Spans) != 101 || !result.Coverage.Tools.Truncated || result.Coverage.Tools.Omitted != 100 || !result.Coverage.Text2SQL.Truncated || result.Coverage.Text2SQL.Omitted != 0 {
		t.Fatalf("status=%d result=%+v", status, result)
	}
}

func TestAppRequestFlowHTTPUsesExistingV2ListIdentity(t *testing.T) {
	f := newAppFlowHTTPFixture(t)
	token := f.token(t, "flow-list-reader", "readonly_admin", "", "admin:read")
	f.seed(t, "flow-list-record", "", f.at, nil)
	r, err := http.NewRequest("GET", f.url+"/admin/requests?limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Vibe-UI", "app")
	r.Header.Set(appRequestContractHeader, "2")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var list appRequestsResponse
	if err := json.NewDecoder(response.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(list.Requests) != 1 {
		t.Fatalf("list=%+v status=%d", list, response.StatusCode)
	}
	row := list.Requests[0]
	path := "/admin/app/request-flow?" + url.Values{"request_ref": {row.RequestRef}, "created_at": {row.CreatedAt}}.Encode()
	status, body := f.get(t, token, "GET", path)
	var flow appRequestFlowResponse
	if err := json.Unmarshal(body, &flow); err != nil {
		t.Fatal(err)
	}
	if status != 200 || flow.RequestRef != row.RequestRef || flow.CreatedAt != row.CreatedAt {
		t.Fatalf("flow=%+v status=%d", flow, status)
	}
}
