package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestWorkflowGraphHTTPLoginMCP(t *testing.T) {
	for _, mode := range []string{"allow", "oauth_active", "scope_denied", "team_denied", "policy_block", "governance_block", "step_allowlist", "session_revoked", "revoked_between_steps", "expired", "bad_token"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			var afterCall atomic.Pointer[func()]
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var msg struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
				}
				if json.NewDecoder(r.Body).Decode(&msg) != nil {
					t.Error("invalid upstream request")
					w.WriteHeader(400)
					return
				}
				if len(msg.ID) == 0 {
					w.WriteHeader(202)
					return
				}
				result := map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "test", "version": "1"}}
				if msg.Method == "tools/call" {
					calls.Add(1)
					result = map[string]any{"content": []map[string]string{{"type": "text", "text": "도구 응답"}}}
					if callback := afterCall.Load(); callback != nil {
						(*callback)()
						result = map[string]any{"content": []map[string]string{{"type": "text", "text": "{}"}}}
					}
				}
				writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
			}))
			defer up.Close()
			s, db := newKnowledgeServer(t)
			s.cfg.Auth.Enabled = true
			s.cfg.Auth.JWTSecret = "workflow-session-test-secret"
			s.cfg.Auth.AccessTokenTTL = 15 * time.Minute
			s.cfg.Auth.RefreshTokenTTL = time.Hour
			s.cfg.Auth.BootstrapEmail = "workflow@example.com"
			s.cfg.Auth.BootstrapPassword = "workflow-test-password"
			if err := s.bootstrapAdmin(t.Context()); err != nil {
				t.Fatal(err)
			}
			gateway := httptest.NewServer(s.Routes())
			defer gateway.Close()
			var session struct {
				AccessToken string `json:"access_token"`
			}
			if err := json.Unmarshal(graphHTTP(t, gateway.URL, "POST", "/auth/login", "", []byte(`{"email":"workflow@example.com","password":"workflow-test-password"}`), 200), &session); err != nil {
				t.Fatal(err)
			}
			claims, ok := s.verifyAccessToken(t.Context(), session.AccessToken)
			if !ok {
				t.Fatal("login did not yield a live session")
			}
			if mode == "oauth_active" {
				s.keycloakCfg.Store(&config.KeycloakConfig{Enabled: true, IssuerURL: "https://idp.invalid/realms/test", ClientID: "test", RedirectURI: "https://gateway.invalid/auth/keycloak/callback", AllowLocalLogin: true})
				graphHTTP(t, gateway.URL, "PUT", "/admin/settings/by-key/"+mcpOAuthEnabledKey, session.AccessToken, []byte(`{"value":"true","reason":"test OAuth re-entry"}`), 200)
				if !s.mcpOAuthState().Active() {
					t.Fatal("OAuth path was not active")
				}
			}
			if mode == "scope_denied" {
				claims.Scopes = []string{"models:read"}
				var err error
				session.AccessToken, err = s.signAccessToken(claims)
				if err != nil {
					t.Fatal(err)
				}
			}
			if mode == "expired" {
				claims.ExpiresAt = time.Now().Add(-time.Minute).Unix()
				var err error
				session.AccessToken, err = s.signAccessToken(claims)
				if err != nil {
					t.Fatal(err)
				}
			}
			if mode == "session_revoked" {
				if err := db.RevokeAuthSession(t.Context(), claims.SessionID); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "bad_token" {
				session.AccessToken = "invalid-test-credential"
			}
			if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{ID: "tools", Name: "workflow-tools", URL: up.URL, Enabled: true}); err != nil {
				t.Fatal(err)
			}
			s.mcpTools.Store(&mcpToolsSnapshot{fetchedAt: time.Now(), routes: map[string]mcpRoute{"tools__echo": {upstreamID: "tools", upstreamName: "workflow-tools", bareTool: "echo"}}})
			wf := store.Workflow{ID: "http-mcp", Name: "로그인 도구 실행", Enabled: true, Steps: []store.WorkflowStep{{ID: "tool", Type: "mcp_tool", Ref: "tools__echo", AllowedTools: []string{"tools__echo"}}}, Flow: &store.WorkflowFlow{Version: 1, Entry: "tool", Edges: []store.WorkflowEdge{{From: "tool", To: store.WorkflowGraphEnd, When: "next"}}}}
			if mode == "revoked_between_steps" {
				revoke := func() {
					if err := db.RevokeAuthSession(t.Context(), claims.SessionID); err != nil {
						t.Error(err)
					}
				}
				afterCall.Store(&revoke)
				second := wf.Steps[0]
				second.ID = "second"
				wf.Steps = append(wf.Steps, second)
				wf.Flow.Edges[0].To = "second"
				wf.Flow.Edges = append(wf.Flow.Edges, store.WorkflowEdge{From: "second", To: store.WorkflowGraphEnd, When: "next"})
			}
			if mode == "team_denied" {
				wf.AllowedTeams = "other-team"
			}
			if mode == "step_allowlist" {
				wf.Steps[0].AllowedTools = []string{"other__tool"}
			}
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
			if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
				t.Fatal(err)
			}
			// The session still cannot authenticate an external MCP request.
			graphHTTP(t, gateway.URL, "POST", "/mcp", session.AccessToken, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tools__echo","arguments":{}}}`), 401)
			wantHTTP := 200
			if mode == "team_denied" {
				wantHTTP = 403
			}
			if mode == "session_revoked" || mode == "expired" || mode == "bad_token" {
				wantHTTP = 401
			}
			raw := graphHTTP(t, gateway.URL, "POST", "/v1/workflows/http-mcp/run", session.AccessToken, []byte(`{"execute":true,"input":"{\"text\":\"private-input-canary\"}"}`), wantHTTP)
			var result struct {
				Status  string `json:"status"`
				RunID   string `json:"run_id"`
				StepsOK int    `json:"steps_ok"`
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			allowed := mode == "allow" || mode == "oauth_active"
			if allowed {
				if result.Status != "ok" || calls.Load() != 1 || result.StepsOK != 1 || !strings.Contains(string(raw), "도구 응답") {
					t.Fatalf("login workflow tool failed: status=%s calls=%d successful_steps=%d", result.Status, calls.Load(), result.StepsOK)
				}
			} else if mode == "revoked_between_steps" {
				if calls.Load() != 1 || result.StepsOK != 1 || result.Status != "error" {
					t.Fatal("revoked session reached the next MCP step")
				}
			} else if calls.Load() != 0 || (wantHTTP == 200 && result.Status != "error") {
				t.Fatalf("denied caller reached tool: status=%s calls=%d", result.Status, calls.Load())
			}
			if strings.Contains(string(raw), "private-input-canary") || strings.Contains(string(raw), session.AccessToken) {
				t.Fatal("workflow exposed input or bearer")
			}
			if wantHTTP == 200 {
				receipt, found, err := db.GetWorkflowRun(t.Context(), result.RunID)
				if err != nil || !found || receipt.UserID != claims.Subject || receipt.Team != claims.TeamID || receipt.Status != result.Status {
					t.Fatal("workflow receipt lost caller or outcome")
				}
			}
		})
	}
}
