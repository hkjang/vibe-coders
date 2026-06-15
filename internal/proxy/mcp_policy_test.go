package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestEvaluateMCPPolicy(t *testing.T) {
	mcpTools := []store.ToolInvocation{
		{ServerLabel: "github", ToolName: "create_issue", IsMCP: true, Source: "definition"},
		{ServerLabel: "filesystem", ToolName: "read", IsMCP: true, Source: "definition"},
	}

	// blocklist: github blocked
	snap := &mcpPolicySnapshot{modes: map[string]string{"github": "block"}}
	d := evaluateMCPPolicy(snap, mcpTools)
	if !d.Blocked || d.BlockedServer != "github" || d.Reason != "server_blocked" {
		t.Fatalf("expected github blocked, got %#v", d)
	}

	// warn: filesystem warn, github allow → not blocked but warned
	snap = &mcpPolicySnapshot{modes: map[string]string{"github": "allow", "filesystem": "warn"}}
	d = evaluateMCPPolicy(snap, mcpTools)
	if d.Blocked {
		t.Fatalf("expected not blocked, got %#v", d)
	}
	if len(d.Warnings) != 1 || d.Warnings[0] != "filesystem" {
		t.Fatalf("expected filesystem warning, got %#v", d.Warnings)
	}

	// allowlist mode: only explicitly allowed servers pass
	snap = &mcpPolicySnapshot{allowlist: true, modes: map[string]string{"github": "allow"}}
	d = evaluateMCPPolicy(snap, mcpTools)
	if !d.Blocked || d.BlockedServer != "filesystem" || d.Reason != "not_in_allowlist" {
		t.Fatalf("expected filesystem blocked by allowlist, got %#v", d)
	}

	// allowlist mode with both allowed
	snap = &mcpPolicySnapshot{allowlist: true, modes: map[string]string{"github": "allow", "filesystem": "allow"}}
	if d = evaluateMCPPolicy(snap, mcpTools); d.Blocked {
		t.Fatalf("expected pass when both allowed, got %#v", d)
	}

	// no MCP tools → never blocked
	if d = evaluateMCPPolicy(snap, []store.ToolInvocation{{ToolName: "plain", IsMCP: false}}); d.Blocked {
		t.Fatal("plain function should not be subject to MCP policy")
	}
}

func TestMCPPolicyBlocksRequestEndToEnd(t *testing.T) {
	var upstreamHits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// block the github MCP server
	resp := postJSON(t, proxy.URL+"/admin/mcp/policies", "", map[string]any{"server_label": "github", "mode": "block"})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("policy create failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	reqBody := map[string]any{
		"model":    "gpt-4.1",
		"tools":    []any{map[string]any{"type": "function", "function": map[string]any{"name": "mcp__github__create_issue"}}},
		"messages": []any{map[string]any{"role": "user", "content": "make an issue"}},
	}
	blocked := postJSON(t, proxy.URL+"/v1/chat/completions", "", reqBody)
	if blocked.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(blocked.Body)
		t.Fatalf("expected 403 from MCP policy, got %d: %s", blocked.StatusCode, body)
	}
	if blocked.Header.Get("X-MCP-Blocked-Server") != "github" {
		t.Fatalf("expected X-MCP-Blocked-Server=github, got %q", blocked.Header.Get("X-MCP-Blocked-Server"))
	}
	blocked.Body.Close()
	if upstreamHits != 0 {
		t.Fatalf("upstream should NOT be called for a blocked request, got %d hits", upstreamHits)
	}

	// a request without the blocked server passes
	okBody := map[string]any{
		"model":    "gpt-4.1",
		"tools":    []any{map[string]any{"type": "function", "function": map[string]any{"name": "get_weather"}}},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	ok := postJSON(t, proxy.URL+"/v1/chat/completions", "", okBody)
	if ok.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(ok.Body)
		t.Fatalf("expected 200 for non-blocked request, got %d: %s", ok.StatusCode, body)
	}
	ok.Body.Close()
}

func TestSessionToolLoopsDetection(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// 12 calls of the same tool within one session → loop
	for i := 0; i < 12; i++ {
		id := "loopreq-" + string(rune('a'+i))
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, SessionID: "sess-loop", Endpoint: "/v1/chat/completions",
				StatusCode: 200, CreatedAt: now.Add(time.Duration(i) * time.Second),
			},
			Tools: []store.ToolInvocation{
				{ID: id + "-t", RequestID: id, TraceID: id, ServerLabel: "github", ToolName: "create_issue",
					Source: "call", IsMCP: true, CreatedAt: now.Add(time.Duration(i) * time.Second)},
			},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}

	loops, err := db.SessionToolLoops(ctx, now.Add(-time.Hour), 10, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(loops) != 1 {
		t.Fatalf("expected 1 loop, got %d (%#v)", len(loops), loops)
	}
	if loops[0].Calls != 12 || loops[0].SessionID != "sess-loop" || loops[0].ServerLabel != "github" {
		t.Fatalf("unexpected loop: %#v", loops[0])
	}

	maxCalls, err := db.MaxSessionToolCallsSince(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if maxCalls != 12 {
		t.Fatalf("expected max session tool calls 12, got %d", maxCalls)
	}

	// threshold above the count → no loops
	loops, err = db.SessionToolLoops(ctx, now.Add(-time.Hour), 20, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(loops) != 0 {
		t.Fatalf("expected no loops above threshold, got %d", len(loops))
	}
}

func TestMCPLoopsEndpoint(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	now := time.Now().UTC()
	for i := 0; i < 11; i++ {
		id := "lr-" + string(rune('a'+i))
		_ = db.InsertLogRecord(context.Background(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, SessionID: "s1", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now},
			Tools:   []store.ToolInvocation{{ID: id + "t", RequestID: id, TraceID: id, ServerLabel: "fs", ToolName: "read", Source: "call", IsMCP: true, CreatedAt: now}},
		})
	}

	resp, err := http.Get(proxy.URL + "/admin/mcp/loops?window=24h&threshold=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Loops     []store.SessionToolLoop `json:"loops"`
		Threshold int                     `json:"threshold"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Loops) != 1 || payload.Loops[0].Calls != 11 {
		t.Fatalf("expected one loop with 11 calls, got %#v", payload.Loops)
	}
}
