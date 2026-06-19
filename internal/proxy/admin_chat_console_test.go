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

func TestAdminChatTestTargetsIncludeGatewaySurfaces(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":           "openai",
		"base_url":       upstream.URL,
		"api_key":        "upstream-secret",
		"timeout_ms":     5000,
		"enabled":        true,
		"model_patterns": "gpt-*,vibe/custom",
	})
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("provider upsert failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	getResp, err := http.Get(proxy.URL + "/admin/chat-test/targets")
	if err != nil {
		t.Fatal(err)
	}
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(getResp.Body)
		t.Fatalf("targets failed: %d %s", getResp.StatusCode, body)
	}
	var out struct {
		Targets []chatTestTarget `json:"targets"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"routing:vibe/auto":              false,
		"text2sql:vibe/text2sql-preview": false,
		"provider:openai:gpt-*":          false,
		"provider:openai:vibe/custom":    false,
		"text2sql:vibe/text2sql-auto":    false,
		"routing:vibe-coders/auto":       false,
		"routing:auto":                   false,
		"routing:vibe/grounded":          false,
		"routing:vibe/research":          false,
		"routing:vibe/all-mcp":           false,
		"routing:vibe/policy":            false,
		"routing:vibe/legal":             false,
		"routing:vibe/compliance":        false,
	}
	for _, target := range out.Targets {
		if _, ok := want[target.ID]; ok {
			want[target.ID] = true
		}
	}
	for id, found := range want {
		if !found {
			t.Fatalf("target %s not found in %#v", id, out.Targets)
		}
	}
}

func TestAdminChatTestRunUsesGatewayPipeline(t *testing.T) {
	modelSeen := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		modelSeen <- body.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{"name": "real-key", "key": "proxy-secret"})
	if createResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createResp.Body)
		t.Fatalf("api key creation failed: %d %s", createResp.StatusCode, body)
	}
	createResp.Body.Close()

	resp := postJSON(t, proxy.URL+"/admin/chat-test/run", "", map[string]any{
		"model":           "test-model",
		"prompt":          "Say pong.",
		"max_tokens":      16,
		"include_preview": true,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("chat test failed: %d %s", resp.StatusCode, body)
	}
	var out struct {
		StatusCode int               `json:"status_code"`
		OK         bool              `json:"ok"`
		AuthMode   string            `json:"auth_mode"`
		Content    string            `json:"content"`
		Headers    map[string]string `json:"headers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.StatusCode != http.StatusOK || out.Content != "pong" {
		t.Fatalf("unexpected chat test output: %#v", out)
	}
	if out.AuthMode != "admin_synthetic" || out.Headers["X-Api-Key-Id"] != "admin_chat_test" {
		t.Fatalf("expected injected admin auth context, got %#v", out)
	}
	if got := <-modelSeen; got != "test-model" {
		t.Fatalf("upstream saw model %q", got)
	}
}

func TestAdminChatTestStreamPassesThroughSSEReasoning(t *testing.T) {
	var streamReq bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		streamReq = body.Stream
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		chunks := []string{
			`{"choices":[{"delta":{"reasoning_content":"thinking..."}}]}`,
			`{"choices":[{"delta":{"content":"po"}}]}`,
			`{"choices":[{"delta":{"content":"ng"},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`,
		}
		for _, c := range chunks {
			_, _ = io.WriteString(w, "data: "+c+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/admin/chat-test/stream", "", map[string]any{
		"model":           "test-model",
		"prompt":          "Say pong.",
		"max_tokens":      64,
		"include_preview": false,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("chat stream failed: %d %s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("expected SSE content-type, got %q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	got := string(body)
	if !streamReq {
		t.Fatalf("upstream did not receive stream:true")
	}
	for _, want := range []string{"reasoning_content", "thinking...", `"po"`, `"ng"`, "finish_reason"} {
		if !strings.Contains(got, want) {
			t.Fatalf("streamed body missing %q; got: %s", want, got)
		}
	}
}
