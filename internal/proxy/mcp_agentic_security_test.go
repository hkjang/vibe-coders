package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestMCPAgenticStreamBoundsProviderAndUpstreamErrors(t *testing.T) {
	const (
		unsafeProvider = "sk-ant-legacy-agentic-secret"
		upstreamSecret = "credential-from-upstream-error"
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"`+upstreamSecret+`","token":"agentic-query-secret"}`)
	}))
	defer upstream.Close()

	server, db, _ := newAdminModelsTestServer(t, "")
	encrypted, err := server.secrets.Load().Encrypt("upstream-api-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: unsafeProvider, BaseURL: upstream.URL + "?api_key=agentic-base-secret",
		EncryptedAPIKey: encrypted, Enabled: true, ModelPatterns: "gpt-agentic-*",
	}); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("X-Proxy-Provider", unsafeProvider)
	recorder := httptest.NewRecorder()
	outcome := server.runMCPAgenticChat(
		recorder,
		request,
		"gpt-agentic-test",
		[]any{map[string]any{"role": "user", "content": "hello"}},
		mcpAgentToolset{routes: map[string]mcpAgentRoute{}},
		MCPDiscoveryPolicy{Model: "vibe/research", MaxSteps: 1},
		"key-agentic",
		nil,
		true,
	)

	visible := recorder.Body.String() + outcome.Provider
	for _, secret := range []string{unsafeProvider, upstreamSecret, "agentic-query-secret", "agentic-base-secret", "api_key"} {
		if strings.Contains(visible, secret) {
			t.Fatalf("streaming agentic response leaked %q: %s", secret, visible)
		}
	}
	if outcome.Provider != boundedModelsProviderLabel(unsafeProvider) {
		t.Fatalf("provider=%q, want bounded label", outcome.Provider)
	}
	if outcome.Err == nil || outcome.Err.Error() != governanceRunErrStatus {
		t.Fatalf("error=%v, want stable %q", outcome.Err, governanceRunErrStatus)
	}
	if !strings.Contains(recorder.Body.String(), governanceRunErrStatus) || !strings.Contains(recorder.Body.String(), boundedModelsProviderLabel(unsafeProvider)) {
		t.Fatalf("stream omitted stable diagnostics: %s", recorder.Body.String())
	}
}

func TestMCPAgenticNonStreamingErrorDoesNotReturnUpstreamBody(t *testing.T) {
	const upstreamSecret = "credential-from-agentic-body"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, upstreamSecret)
	}))
	defer upstream.Close()

	server, db, _ := newAdminModelsTestServer(t, "")
	encrypted, err := server.secrets.Load().Encrypt("upstream-api-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: "safe-agentic", BaseURL: upstream.URL, EncryptedAPIKey: encrypted,
		Enabled: true, ModelPatterns: "gpt-agentic-*",
	}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("X-Proxy-Provider", "safe-agentic")
	raw, _, err := server.postUpstreamChat(t.Context(), request, "gpt-agentic-test", map[string]any{"messages": []any{}})
	if err == nil || err.Error() != governanceRunErrStatus {
		t.Fatalf("error=%v, want stable %q", err, governanceRunErrStatus)
	}
	if len(raw) != 0 || strings.Contains(err.Error(), upstreamSecret) {
		t.Fatalf("non-success body escaped: raw=%q err=%v", raw, err)
	}
}

func TestMCPAgenticToolCallErrorIsStable(t *testing.T) {
	const upstreamSecret = "credential-from-mcp-upstream"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, upstreamSecret)
	}))
	defer upstream.Close()

	server, db, _ := newAdminModelsTestServer(t, "")
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "mcp-agentic-error", Name: "MCP error source",
		URL: upstream.URL + "?token=mcp-query-secret", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	content, evidence := server.execAgentToolCall(request, "key-agentic", nil, mcpAgentRoute{
		upstreamID: "mcp-agentic-error", upstreamName: "MCP error source",
		bareTool: "lookup", namespaced: "mcp-agentic-error__lookup",
	}, `{}`)
	visible := content + evidence.Error
	for _, secret := range []string{upstreamSecret, "mcp-query-secret", "token="} {
		if strings.Contains(visible, secret) {
			t.Fatalf("agent tool error leaked %q: %s", secret, visible)
		}
	}
	if content != "ERROR: MCP upstream request failed" || evidence.Error != "MCP upstream request failed" {
		t.Fatalf("tool error was not stable: content=%q evidence=%q", content, evidence.Error)
	}
}
