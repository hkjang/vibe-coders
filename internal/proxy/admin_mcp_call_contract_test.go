package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMCPCallOpenAPIContract(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/mcp/route/explain", "post", "200", "McpRouteExplainResponse")
	assertJSONOperationSchema(t, paths, "/admin/mcp/test", "post", "200", "McpTestResponse")
	for _, path := range []string{"/admin/mcp/route/explain", "/admin/mcp/test"} {
		for _, status := range []string{"400", "401", "405"} {
			assertJSONOperationSchema(t, paths, path, "post", status, "AppError")
		}
	}
}

func TestMCPCallActualScopes(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-mcp-call-session-secret"
	s.mcpTools.Store(&mcpToolsSnapshot{fetchedAt: time.Now()})
	for _, scopes := range [][]string{{"observability:read"}, {"mcp:admin"}} {
		for _, path := range []string{"/admin/mcp/route/explain", "/admin/mcp/test"} {
			t.Run(scopes[0]+path, func(t *testing.T) {
				token := issueMCPScopedTestToken(t, db, s, scopes[0]+strings.ReplaceAll(path, "/", "_"), "viewer", "", scopes, time.Now())
				r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"method":"tools/call","name":"absent"}`))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				s.Routes().ServeHTTP(w, r)
				want := 401
				if scopes[0] == "mcp:admin" {
					want = 200
					if path == "/admin/mcp/test" {
						want = 404
					}
				}
				if w.Code != want {
					t.Fatalf("MCP operation status %d, want %d", w.Code, want)
				}
			})
		}
	}
}
