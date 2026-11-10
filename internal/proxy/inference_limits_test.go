package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// A key's scope, model list and budget describe what it may spend on models, so they cannot
// depend on which of the upstream's inference endpoints the caller happened to pick.
func TestKeyLimitsCoverEveryInferenceEndpoint(t *testing.T) {
	bodies := map[string]string{
		"/v1/responses":   `{"model":"test-model","max_output_tokens":100,"input":"합성 요청입니다"}`,
		"/v1/completions": `{"model":"test-model","max_tokens":100,"prompt":"합성 요청입니다"}`,
		"/v1/messages":    `{"model":"test-model","max_tokens":100,"messages":[{"role":"user","content":"합성 요청입니다"}]}`,
	}
	for path, body := range bodies {
		t.Run(path, func(t *testing.T) {
			f := newCostGuardExecutionContractFixture(t)
			call := func(name string, mutate func(*store.APIKeyRecord)) (int, string) {
				t.Helper()
				token := "vc_sk_synthetic_" + name
				key := store.APIKeyRecord{
					ID: name, Name: name, KeyHash: hashProxyKey(token), Role: "developer", Status: "active",
					Scopes: []string{"chat:completion"},
				}
				mutate(&key)
				if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
					t.Fatal(err)
				}
				request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.gateway.URL+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Authorization", "Bearer "+token)
				request.Header.Set("Content-Type", "application/json")
				response, err := f.gateway.Client().Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				data, _ := io.ReadAll(response.Body)
				var result struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				_ = json.Unmarshal(data, &result)
				return response.StatusCode, result.Error.Code
			}

			if status, _ := call("plain", func(*store.APIKeyRecord) {}); status != http.StatusOK || f.upstreamCalls.Load() != 1 {
				t.Fatalf("a permitted key must reach the model: status=%d calls=%d", status, f.upstreamCalls.Load())
			}
			f.upstreamCalls.Store(0)

			if status, _ := call("noscope", func(key *store.APIKeyRecord) { key.Scopes = []string{"embeddings:create"} }); status < 400 {
				t.Fatalf("a key without the inference scope was allowed: status=%d", status)
			}
			if status, code := call("model", func(key *store.APIKeyRecord) { key.AllowedModels = []string{"other-model"} }); status != http.StatusForbidden || code != "model_denied" {
				t.Fatalf("a model off the key's list was allowed: status=%d code=%q", status, code)
			}
			if status, code := call("denied", func(key *store.APIKeyRecord) { key.DeniedModels = []string{"test-model"} }); status != http.StatusForbidden || code != "model_denied" {
				t.Fatalf("a model on the key's deny list was allowed: status=%d code=%q", status, code)
			}
			if status, code := call("budget", func(key *store.APIKeyRecord) { key.BudgetLimitKRW = 0.000001 }); status != http.StatusPaymentRequired || code != "budget_denied" {
				t.Fatalf("a request over the key's budget was allowed: status=%d code=%q", status, code)
			}
			if f.upstreamCalls.Load() != 0 {
				t.Fatalf("a denied request reached the model %d times", f.upstreamCalls.Load())
			}
		})
	}
}

func TestMCPCallsDoNotGrowLoggedRequests(t *testing.T) {
	server, _, _ := newAdminModelsTestServer(t, "")
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	for range 20 {
		server.logMCPCall(request, "key", "server", "tool", nil, false, http.StatusOK, 1)
	}
	entries := 0
	server.loggedRequests.Range(func(_, _ any) bool {
		entries++
		return true
	})
	if entries != 0 {
		t.Fatalf("loggedRequests kept %d entries after MCP calls", entries)
	}
}

func TestExtractAuditCapturesEveryInferenceInputShape(t *testing.T) {
	roles := func(body, endpoint string) string {
		_, _, prompts, _ := extractAudit([]byte(body), endpoint, false)
		parts := make([]string, 0, len(prompts))
		for _, prompt := range prompts {
			parts = append(parts, prompt.Role+"="+prompt.RedactedText)
		}
		return strings.Join(parts, "|")
	}
	if got := roles(`{"system":"지시","messages":[{"role":"user","content":[{"type":"text","text":"질문"}]},{"role":"assistant","content":"답"}],"tools":[{"name":"t"}]}`, "/v1/messages"); got != `system=지시|user=질문|assistant=답|tools=[{"name":"t"}]` {
		t.Fatalf("messages input=%q", got)
	}
	if got := roles(`{"system":[{"type":"text","text":"블록 지시"}],"messages":[{"role":"user","content":"질문"}]}`, "/v1/messages"); got != "system=블록 지시|user=질문" {
		t.Fatalf("messages block system=%q", got)
	}
	if got := roles(`{"instructions":"지시","input":"질문","tools":[{"type":"function","name":"t"}]}`, "/v1/responses"); got != `system=지시|user=질문|tools=[{"name":"t","type":"function"}]` {
		t.Fatalf("responses input=%q", got)
	}
}
