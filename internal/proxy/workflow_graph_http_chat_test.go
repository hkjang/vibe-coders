package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func TestWorkflowGraphHTTPLoginChat(t *testing.T) {
	for _, mode := range []string{"allow", "scope_denied", "revoked_between_steps", "legacy_unchanged"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			var afterCall atomic.Pointer[func()]
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body struct {
					MaxTokens int `json:"max_tokens"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || body.MaxTokens != 12 {
					t.Error("workflow lost its output token limit")
				}
				if callback := afterCall.Load(); callback != nil {
					(*callback)()
				}
				writeJSON(w, 200, map[string]any{"id": "test", "model": "gpt-4.1-mini", "choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": "모델 응답"}}}, "usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
			}))
			defer upstream.Close()
			db, gateway := newAuthTestServer(t, upstream.URL)
			defer gateway.Close()
			email := "root@example.com"
			if mode == "scope_denied" {
				root, found, err := db.AuthUserByEmail(t.Context(), email)
				if err != nil || !found {
					t.Fatal("bootstrap account missing")
				}
				email = "viewer@example.com"
				if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: "workflow-viewer", Email: email, Name: "조회 사용자", Role: "viewer", Status: "active", PasswordHash: root.PasswordHash}); err != nil {
					t.Fatal(err)
				}
			}
			login, _ := json.Marshal(map[string]string{"email": email, "password": "correct-password"})
			var session struct {
				AccessToken string `json:"access_token"`
			}
			if err := json.Unmarshal(graphHTTP(t, gateway.URL, "POST", "/auth/login", "", login, 200), &session); err != nil {
				t.Fatal(err)
			}
			var me struct {
				User struct {
					ID string `json:"id"`
				} `json:"user"`
			}
			if err := json.Unmarshal(graphHTTP(t, gateway.URL, "GET", "/auth/me", session.AccessToken, nil, 200), &me); err != nil || me.User.ID == "" {
				t.Fatal("login identity missing")
			}
			wf := store.Workflow{ID: "chat-login", Name: "로그인 모델 실행", Enabled: true, Steps: []store.WorkflowStep{{ID: "chat", Type: "chat", Ref: "gpt-4.1-mini", MaxTokens: 12}}, Flow: &store.WorkflowFlow{Version: 1, Entry: "chat", Edges: []store.WorkflowEdge{{From: "chat", To: store.WorkflowGraphEnd, When: "next"}}}}
			if mode == "legacy_unchanged" {
				wf.Flow = nil
				wf.Steps[0].ID = ""
			}
			if mode == "revoked_between_steps" {
				revoke := func() {
					if err := db.RevokeAuthSessionsForUser(t.Context(), me.User.ID); err != nil {
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
			if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
				t.Fatal(err)
			}
			graphHTTP(t, gateway.URL, "POST", "/v1/chat/completions", session.AccessToken, []byte(`{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"test"}]}`), 401)
			raw := graphHTTP(t, gateway.URL, "POST", "/v1/workflows/chat-login/run", session.AccessToken, []byte(`{"execute":true,"input":"private-test-input"}`), 200)
			var result struct {
				Status  string `json:"status"`
				RunID   string `json:"run_id"`
				StepsOK int    `json:"steps_ok"`
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "allow":
				if result.Status != "ok" || calls.Load() != 1 || result.StepsOK != 1 || !strings.Contains(string(raw), "모델 응답") {
					t.Fatalf("login workflow chat failed: status=%s model_calls=%d", result.Status, calls.Load())
				}
			case "revoked_between_steps":
				if result.Status != "error" || calls.Load() != 1 || result.StepsOK != 1 {
					t.Fatal("revoked session reached another model step")
				}
			default:
				if result.Status != "error" || calls.Load() != 0 {
					t.Fatal("workflow broadened existing authentication")
				}
			}
			receipt, found, err := db.GetWorkflowRun(t.Context(), result.RunID)
			if err != nil || !found || receipt.UserID != me.User.ID || receipt.Status != result.Status {
				t.Fatal("model workflow receipt lost identity or result")
			}
			if strings.Contains(string(raw), "private-test-input") || strings.Contains(string(raw), session.AccessToken) {
				t.Fatal("workflow response exposed input or token")
			}
		})
	}
}
