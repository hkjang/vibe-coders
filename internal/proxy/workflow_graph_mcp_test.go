package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestWorkflowGraphMCPUsesGatewayPolicyAndAuthentication(t *testing.T) {
	for _, mode := range []string{"allow", "policy_block", "governance_block", "step_allowlist", "invalid_input", "bad_auth", "tool_error", "missing_result", "missing_auth", "scope_denied"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				if len(req.ID) == 0 {
					w.WriteHeader(202)
					return
				}
				result := map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "workflow-test", "version": "1"}}
				if req.Method == "tools/call" {
					calls.Add(1)
					var params struct {
						Name      string            `json:"name"`
						Arguments map[string]string `json:"arguments"`
					}
					if json.Unmarshal(req.Params, &params) != nil || params.Name != "echo" || params.Arguments["text"] != "private input" {
						t.Error("wrong forwarded tool arguments")
					}
					result = map[string]any{"content": []map[string]string{{"type": "text", "text": "도구의 실제 응답"}}, "isError": mode == "tool_error"}
				}
				if mode == "missing_result" && req.Method == "tools/call" {
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID})
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
			}))
			defer up.Close()
			s, db := newKnowledgeServer(t)
			s.cfg.Auth.Enabled = true
			scopes := []string{"mcp:use"}
			if mode == "scope_denied" {
				scopes = []string{"models:read"}
			}
			if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "workflow-key", Name: "workflow-test", KeyHash: hashProxyKey("workflow-fixture-key"), UserID: "workflow-user", Status: "active", Scopes: scopes}); err != nil {
				t.Fatal(err)
			}
			if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "tool-server", Name: "workflow-tools", URL: up.URL, Enabled: true}); err != nil {
				t.Fatal(err)
			}
			s.mcpTools.Store(&mcpToolsSnapshot{fetchedAt: time.Now(), routes: map[string]mcpRoute{"tool-server__echo": {upstreamID: "tool-server", upstreamName: "workflow-tools", bareTool: "echo"}}})
			if mode == "policy_block" {
				if err := db.UpsertMCPPolicy(t.Context(), store.MCPPolicy{ServerLabel: "workflow-tools", Mode: "block"}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "governance_block" {
				if err := db.UpsertToolRiskProfile(t.Context(), store.ToolRiskProfile{ID: "block", ServerLabel: "workflow-tools", ToolName: "echo", RiskLevel: "critical", Action: "block"}); err != nil {
					t.Fatal(err)
				}
			}
			step := store.WorkflowStep{ID: "tool", Type: "mcp_tool", Ref: "tool-server__echo", AllowedTools: []string{"tool-server__echo"}}
			if mode == "step_allowlist" {
				step.AllowedTools = []string{"other__tool"}
			}
			input := `{"text":"private input"}`
			if mode == "invalid_input" {
				input = `["not an object"]`
			}
			r := httptest.NewRequest("POST", "/v1/workflows/graph/run", nil)
			if mode != "missing_auth" {
				r.Header.Set("Authorization", "Bearer workflow-fixture-key")
			}
			if mode == "bad_auth" {
				r.Header.Set("Authorization", "Bearer unknown-workflow-credential")
			}
			wf := store.Workflow{Steps: []store.WorkflowStep{step}, Flow: &store.WorkflowFlow{Version: 1, Entry: "tool", Edges: []store.WorkflowEdge{{From: "tool", To: store.WorkflowGraphEnd, When: "next"}}}}
			results, status, count, _ := s.executeWorkflowSteps(r, wf, input, accessClaims{})
			if mode == "allow" {
				if status != "ok" || count != 1 || calls.Load() != 1 || results[0]["output"] != "도구의 실제 응답" {
					t.Fatalf("tool did not execute: %s %d %+v calls=%d", status, count, results, calls.Load())
				}
			} else {
				if status != "error" || count != 0 {
					t.Fatalf("unsafe tool marked successful: %s %+v", status, results)
				}
				want := int32(0)
				if mode == "tool_error" || mode == "missing_result" {
					want = 1
				}
				if calls.Load() != want {
					t.Fatalf("unexpected upstream calls: %d", calls.Load())
				}
				encoded, _ := json.Marshal(results)
				if strings.Contains(string(encoded), "private input") || strings.Contains(string(encoded), "unknown-workflow-credential") {
					t.Fatal("error exposed input or credential")
				}
			}
		})
	}
}
