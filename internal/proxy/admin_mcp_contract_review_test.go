package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMCPContractReviewOpenAPI(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	for _, item := range []struct{ path, method, schema string }{
		{"/admin/gateway-mcp/info", "get", "GatewayMcpInfoResponse"},
		{"/admin/mcp/contracts", "get", "McpContractListResponse"},
		{"/admin/mcp/contracts", "post", "McpContractSavedResponse"},
		{"/admin/mcp/contracts", "delete", "McpContractDeletedResponse"},
		{"/admin/mcp/contracts/validate", "post", "McpContractValidationResponse"},
	} {
		assertJSONOperationSchema(t, paths, item.path, item.method, "200", item.schema)
	}
}

func TestMCPContractReviewPreservesDeclarations(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	body := map[string]any{"id": "review-contract", "namespace": "gateway", "name": "gateway_chat", "risk_level": "high", "input_schema": "{\"type\":\"object\"}", "output_schema": "{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"string\"}}}", "enabled": false}
	for _, owner := range []string{"before", "after"} {
		body["owner"] = owner
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/admin/mcp/contracts", bytes.NewReader(encoded)))
		if w.Code != 200 {
			t.Fatalf("contract save status %d", w.Code)
		}
		row, found, err := db.GetMCPToolContract(t.Context(), "review-contract")
		if err != nil || !found || row.OutputSchema != body["output_schema"] || row.InputSchema != body["input_schema"] || row.Enabled || row.Owner != owner {
			t.Fatal("stored declaration did not match reviewed fields")
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/admin/mcp/contracts?id=review-contract", nil))
	if w.Code != 200 {
		t.Fatalf("contract delete status %d", w.Code)
	}
	_, found, err := db.GetMCPToolContract(t.Context(), "review-contract")
	if err != nil || found {
		t.Fatal("deleted declaration remains")
	}
}

func TestMCPContractReviewActualScopes(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-mcp-contract-session-secret"
	for _, scope := range []string{"admin:read", "observability:read", "mcp:admin"} {
		for index, item := range []struct{ method, path, scope string }{
			{"GET", "/admin/gateway-mcp/info", "admin:read"},
			{"GET", "/admin/mcp/contracts", "observability:read"},
			{"POST", "/admin/mcp/contracts/validate", "mcp:admin"},
		} {
			t.Run(scope+item.path, func(t *testing.T) {
				token := issueMCPScopedTestToken(t, db, s, scope+string(rune('a'+index)), "viewer", "", []string{scope}, time.Now())
				r := httptest.NewRequest(item.method, item.path, bytes.NewBufferString("{}"))
				r.Header.Set("Authorization", "Bearer "+token)
				w := httptest.NewRecorder()
				s.Routes().ServeHTTP(w, r)
				want := 401
				if scope == item.scope {
					want = 200
				}
				if w.Code != want {
					t.Fatalf("status %d, want %d", w.Code, want)
				}
			})
		}
	}
}
