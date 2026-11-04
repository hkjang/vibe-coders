package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMCPTopologyReadContract(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "topology-server", Name: "연결 검증", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	s.mcpTools.Store(&mcpToolsSnapshot{fetchedAt: time.Now(), routes: map[string]mcpRoute{"topology__read": {upstreamID: "topology-server", upstreamName: "연결 검증", bareTool: "read"}}})
	w := httptest.NewRecorder()
	s.handleMCPTopology(w, httptest.NewRequest(http.MethodGet, "/admin/mcp/topology", nil))
	var response struct {
		Nodes []map[string]string `json:"nodes"`
		Edges []map[string]string `json:"edges"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatal("topology read failed")
	}
	if len(response.Nodes) != 3 || len(response.Edges) != 2 {
		t.Fatal("topology must include configured server and discovered tool")
	}
	found := false
	for _, edge := range response.Edges {
		if edge["from"] == "upstream:topology-server" && edge["to"] == "tool:topology__read" && edge["label"] == "tools/call" {
			found = true
		}
	}
	if !found {
		t.Fatal("topology edge differs from cached route")
	}
	if required := adminRequiredScope(httptest.NewRequest(http.MethodGet, "/admin/mcp/topology", nil)); required != "observability:read" {
		t.Fatal("topology must preserve read-only scope")
	}
}

func TestMCPTopologyStorageFailureIsNotEmptySuccess(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleMCPTopology(w, httptest.NewRequest(http.MethodGet, "/admin/mcp/topology", nil))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "mcp_topology_unavailable") || strings.Contains(w.Body.String(), "nodes") || strings.Contains(w.Body.String(), "database") {
		t.Fatal("storage failure must be a safe explicit error without a topology")
	}
}

func TestMCPTopologyOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/mcp/topology", "get", "200", "McpTopologyResponse")
	for _, status := range []string{"401", "405", "503"} {
		assertJSONOperationSchema(t, paths, "/admin/mcp/topology", "get", status, "AppError")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"McpTopologyResponse", "McpTopologyNode", "McpTopologyEdge"} {
		if schemas[name] == nil {
			t.Fatal("missing topology schema")
		}
	}
}

func TestMCPTopologyActualReadScope(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-topology-session-secret"
	s.mcpTools.Store(&mcpToolsSnapshot{fetchedAt: time.Now()})
	for _, tc := range []struct {
		name   string
		scopes []string
		status int
	}{
		{"reader", []string{"observability:read"}, 200},
		{"admin-without-observability", []string{"admin:read"}, 401},
		{"writer-without-read", []string{"mcp:admin"}, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueMCPScopedTestToken(t, db, s, tc.name, "viewer", "", tc.scopes, time.Now())
			r := httptest.NewRequest(http.MethodGet, "/admin/mcp/topology", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("topology status %d, want %d", w.Code, tc.status)
			}
		})
	}
}
