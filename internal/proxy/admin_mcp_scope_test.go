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

func TestMCPAdminAuxiliarySurfacesEnforceTeamScopeAndProjection(t *testing.T) {
	const (
		upstreamCredential = "vc_sk_abcdefghijklmnopqrstuvwxyzABCDEF"
		toolCredential     = "ghp_abcdefghijklmnopqrstuvwxyz123456"
	)
	upstream := mcpProjectionTestUpstream(t, toolCredential)
	defer upstream.Close()

	db := openTestStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Add(-time.Minute)
	for _, team := range []store.AuthTeam{
		{ID: "mcp-alpha-id", Name: "mcp-alpha-name"},
		{ID: "mcp-beta-id", Name: "mcp-beta-name"},
	} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []store.APIKeyRecord{
		{ID: "mcp-alpha-key", Name: "alpha", KeyHash: "mcp-alpha-hash", Team: "mcp-alpha-name", Status: "active"},
		{ID: "mcp-beta-key", Name: "beta", KeyHash: "mcp-beta-hash", Team: "mcp-beta-name", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	for _, request := range []struct {
		id  string
		key string
	}{
		{id: "mcp-alpha-request", key: "mcp-alpha-key"},
		{id: "mcp-beta-request", key: "mcp-beta-key"},
	} {
		insertMCPScopedRequest(t, db, request.id, request.key, upstreamCredential, toolCredential, now)
	}
	legacyURL := "http://probe-user:probe-password@" + strings.TrimPrefix(upstream.URL, "http://")
	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{
		ID: "mcp-legacy", Name: upstreamCredential, URL: legacyURL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{Description: "owner@example.com " + toolCredential},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertMCPDiscoveryRun(ctx, store.MCPDiscoveryRun{
		ID: "mcp-discovery", UpstreamID: "mcp-legacy", UpstreamName: upstreamCredential,
		Status: "error", Error: "owner@example.com " + toolCredential, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "mcp-scope.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "mcp-team-scope-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	cfg.Auth.ServiceKeyPrefix = "vc_sa_"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	teamToken := issueMCPScopedTestToken(t, db, server, "mcp-team-admin", "team_admin", "mcp-alpha-id", []string{"observability:read"}, now)
	adminToken := issueMCPScopedTestToken(t, db, server, "mcp-super-admin", "super_admin", "", []string{"observability:read"}, now)
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()

	get := func(token, path string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}

	status, flow := get(teamToken, "/admin/mcp/upstreams/mcp-legacy/flow")
	if status != http.StatusOK || !strings.Contains(string(flow), "mcp-alpha-request") {
		t.Fatalf("team MCP flow lost own request: status=%d body=%s", status, flow)
	}
	assertMCPExternalBody(t, flow, "mcp-beta-request", upstreamCredential, toolCredential, "probe-user", "probe-password", "owner@example.com")
	var flowPayload struct {
		ToolStats []store.MCPToolStat   `json:"tool_stats"`
		Recent    []store.RecentRequest `json:"recent_requests"`
	}
	if err := json.Unmarshal(flow, &flowPayload); err != nil {
		t.Fatal(err)
	}
	if len(flowPayload.Recent) != 1 || len(flowPayload.ToolStats) != 1 || flowPayload.ToolStats[0].Calls != 1 {
		t.Fatalf("team MCP flow was not consistently scoped: %+v", flowPayload)
	}

	status, probe := get(teamToken, "/admin/mcp/upstreams/mcp-legacy/probe")
	if status != http.StatusOK {
		t.Fatalf("team MCP probe status=%d body=%s", status, probe)
	}
	assertMCPExternalBody(t, probe, upstreamCredential, toolCredential, "probe-user", "probe-password", "owner@example.com")

	status, ownAgentic := get(teamToken, "/admin/mcp/agentic-runs?request_id=mcp-alpha-request")
	if status != http.StatusOK || !strings.Contains(string(ownAgentic), `"agentic":true`) {
		t.Fatalf("team MCP agentic run lost own request: status=%d body=%s", status, ownAgentic)
	}
	assertMCPExternalBody(t, ownAgentic, upstreamCredential, toolCredential, "owner@example.com")
	if status, body := get(teamToken, "/admin/mcp/agentic-runs?request_id=mcp-beta-request"); status != http.StatusForbidden {
		t.Fatalf("team MCP agentic run crossed team scope: status=%d body=%s", status, body)
	}

	status, adminFlow := get(adminToken, "/admin/mcp/upstreams/mcp-legacy/flow")
	if status != http.StatusOK || !strings.Contains(string(adminFlow), "mcp-alpha-request") ||
		!strings.Contains(string(adminFlow), "mcp-beta-request") || !strings.Contains(string(adminFlow), upstreamCredential) {
		t.Fatalf("full admin MCP flow lost unrestricted raw compatibility: status=%d body=%s", status, adminFlow)
	}
	status, adminProbe := get(adminToken, "/admin/mcp/upstreams/mcp-legacy/probe")
	if status != http.StatusOK || !strings.Contains(string(adminProbe), upstreamCredential) || !strings.Contains(string(adminProbe), toolCredential) {
		t.Fatalf("full admin MCP probe lost raw compatibility: status=%d body=%s", status, adminProbe)
	}
	status, adminAgentic := get(adminToken, "/admin/mcp/agentic-runs?request_id=mcp-beta-request")
	if status != http.StatusOK || !strings.Contains(string(adminAgentic), upstreamCredential) || !strings.Contains(string(adminAgentic), toolCredential) {
		t.Fatalf("full admin MCP agentic run lost raw compatibility: status=%d body=%s", status, adminAgentic)
	}
}

func TestMCPAgenticRunMethodAndIdentifierContract(t *testing.T) {
	server := &Server{}
	for _, test := range []struct {
		method string
		path   string
		status int
		allow  string
	}{
		{method: http.MethodPost, path: "/admin/mcp/agentic-runs?request_id=req-1", status: http.StatusMethodNotAllowed, allow: http.MethodGet},
		{method: http.MethodGet, path: "/admin/mcp/agentic-runs?request_id=../req-1", status: http.StatusBadRequest},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, test.path, nil)
		server.handleMCPAgenticRuns(recorder, request)
		if recorder.Code != test.status || recorder.Header().Get("Allow") != test.allow {
			t.Fatalf("%s %s: status=%d Allow=%q", test.method, test.path, recorder.Code, recorder.Header().Get("Allow"))
		}
	}
}

func insertMCPScopedRequest(t *testing.T, db *store.SQLStore, requestID, apiKeyID, upstreamName, toolName string, createdAt time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: requestID + "-trace", APIKeyID: apiKeyID,
			Endpoint: "/v1/chat/completions", Model: requestID + "-model", Provider: upstreamName,
			StatusCode: http.StatusOK, SessionID: requestID + "-session", CreatedAt: createdAt,
		},
		Prompts: []store.PromptLog{{
			ID: requestID + "-prompt", RequestID: requestID, Role: "user",
			ContentText: "raw " + toolName, RedactedText: "owner@example.com " + toolName, CreatedAt: createdAt,
		}},
		Tools: []store.ToolInvocation{{
			ID: requestID + "-tool", RequestID: requestID, TraceID: requestID + "-trace", APIKeyID: apiKeyID,
			ServerLabel: upstreamName, ToolName: toolName, Source: "call", IsMCP: true, CreatedAt: createdAt,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertDomainRoutingDecision(t.Context(), store.DomainRoutingDecision{
		ID: requestID + "-decision", RequestID: requestID, TeamID: apiKeyID,
		QueryHash: requestID + "-hash", Route: upstreamName, Confidence: 0.9,
		ToolNames: []string{toolName}, EvidenceScore: 0.8, EvidenceCount: 1,
		Reason: "owner@example.com " + upstreamName, CreatedAt: createdAt.Format(time.RFC3339Nano),
	}, []store.DomainRoutingSignal{{
		ID: requestID + "-signal", Source: "selector", Route: upstreamName, Score: 0.9, Reason: toolName,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertMCPRouteDecision(t.Context(), store.MCPRouteDecision{
		ID: requestID + "-route", RequestID: requestID, TraceID: requestID + "-trace", APIKeyID: apiKeyID,
		Method: "tools/call", ExposedName: toolName, UpstreamID: "mcp-legacy", UpstreamName: upstreamName,
		TargetName: toolName, ServerPolicy: "allow", FinalDecision: "allow", Reason: "owner@example.com " + toolName,
		CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func issueMCPScopedTestToken(t *testing.T, db *store.SQLStore, server *Server, subject, role, teamID string, scopes []string, now time.Time) string {
	t.Helper()
	sessionID := subject + "-session"
	if err := db.InsertAuthSession(t.Context(), sessionID, subject, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	token, err := server.signAccessToken(accessClaims{
		Subject: subject, Role: role, TeamID: teamID, Scopes: scopes, SessionID: sessionID,
		Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func assertMCPExternalBody(t *testing.T, body []byte, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if value != "" && strings.Contains(string(body), value) {
			t.Fatalf("external MCP response exposed %q: %s", value, body)
		}
	}
}

func mcpProjectionTestUpstream(t *testing.T, credential string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "initialize":
			response["result"] = map[string]any{
				"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{"name": "projection", "version": "1"},
			}
		case "tools/list":
			response["result"] = map[string]any{"tools": []map[string]any{{"name": credential, "description": "owner@example.com " + credential}}}
		case "resources/list":
			response["error"] = map[string]any{"code": -32000, "message": "owner@example.com " + credential}
		case "resources/templates/list":
			response["result"] = map[string]any{"resourceTemplates": []any{}}
		case "prompts/list":
			response["result"] = map[string]any{"prompts": []map[string]any{{"name": credential}}}
		default:
			response["error"] = map[string]any{"code": -32601, "message": "method not found"}
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
}
