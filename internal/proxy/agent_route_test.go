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

	"vibe-coders/internal/store"
)

// TestAgentRouteEndToEnd verifies a stored virtual model runs the agentic loop against its pinned
// provider/backing model and returns a normal chat completion (no MCP tools needed for this path).
func TestAgentRouteEndToEnd(t *testing.T) {
	var gotModel, gotProvider string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/chat/completions") {
			body, _ := io.ReadAll(r.Body)
			var req struct {
				Model string `json:"model"`
			}
			_ = json.Unmarshal(body, &req)
			gotModel = req.Model
			gotProvider = r.Header.Get("X-Proxy-Provider")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"근거를 조회해 답변합니다."}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer upstream.Close()

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	ctx := context.Background()

	enc, _ := server.secrets.Load().Encrypt("sk-up")
	if err := db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: upstream.URL, EncryptedAPIKey: enc, Enabled: true, ModelPatterns: "gpt-*"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(ctx, store.AgentRoute{
		ID: "agr_e2e", VirtualModel: "vibe/agent-e2e", Name: "e2e", Enabled: true,
		BackingModel: "gpt-4o", Provider: "openai", SystemPrompt: "너는 테스트 에이전트다", MaxSteps: 2,
	}); err != nil {
		t.Fatal(err)
	}

	reqBody := `{"model":"vibe/agent-e2e","messages":[{"role":"user","content":"안녕"}]}`
	resp, err := http.Post(proxy.URL+"/v1/chat/completions", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("agent route call failed: %d %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Agent-Route") != "vibe/agent-e2e" {
		t.Fatalf("expected X-Agent-Route header, got %q", resp.Header.Get("X-Agent-Route"))
	}
	if resp.Header.Get("X-Agent-Provider") != "openai" || resp.Header.Get("X-Agent-Backing-Model") != "gpt-4o" {
		t.Fatalf("agent headers wrong: provider=%q model=%q", resp.Header.Get("X-Agent-Provider"), resp.Header.Get("X-Agent-Backing-Model"))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Choices) == 0 || !strings.Contains(out.Choices[0].Message.Content, "근거") {
		t.Fatalf("expected agentic answer, got %#v", out)
	}
	// The loop must have called the upstream with the route's backing model.
	if gotModel != "gpt-4o" {
		t.Fatalf("backing call used wrong model: %q", gotModel)
	}
	_ = gotProvider // X-Proxy-Provider is consumed by the gateway, not forwarded upstream
}

// TestAgentRouteAdminTest verifies the admin in-app test endpoint runs the route server-side
// (using the provider's own key) and returns the answer + loop stats.
func TestAgentRouteAdminTest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"테스트 응답입니다."}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	ctx := context.Background()

	enc, _ := server.secrets.Load().Encrypt("sk-up")
	_ = db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: upstream.URL, EncryptedAPIKey: enc, Enabled: true, ModelPatterns: "gpt-*"})
	_ = db.UpsertAgentRoute(ctx, store.AgentRoute{ID: "agr_t", VirtualModel: "vibe/agent-t", Enabled: true, BackingModel: "gpt-4o", Provider: "openai"})

	resp := postJSON(t, proxy.URL+"/admin/agent-routes/agr_t/test", "", map[string]any{"prompt": "안녕"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("test endpoint failed: %d %s", resp.StatusCode, body)
	}
	var out struct {
		OK           bool   `json:"ok"`
		Content      string `json:"content"`
		BackingModel string `json:"backing_model"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || !strings.Contains(out.Content, "테스트 응답") || out.BackingModel != "gpt-4o" {
		t.Fatalf("unexpected test result: %#v", out)
	}
}

// TestAgentRouteReservedModelRejected ensures built-in virtual model names can't be shadowed.
func TestAgentRouteReservedModelRejected(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig("http://upstream.local", "k"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/agent-routes", "", map[string]any{"virtual_model": "vibe/all-mcp"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for reserved model, got %d", resp.StatusCode)
	}
}
