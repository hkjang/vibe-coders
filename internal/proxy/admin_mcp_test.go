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

func TestMCPEndToEndAggregation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"","tool_calls":[{"type":"function","function":{"name":"mcp__github__create_issue","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`))
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

	// request that declares an MCP tool, calls it, and includes a failing tool result
	reqBody := map[string]any{
		"model": "gpt-4.1",
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{"name": "mcp__github__create_issue"}},
		},
		"messages": []any{
			map[string]any{"role": "user", "content": "create an issue"},
			map[string]any{"role": "tool", "name": "mcp__github__create_issue", "content": `{"isError":true,"message":"403 forbidden"}`},
		},
	}
	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", reqBody)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	waitFor(t, 2*time.Second, func() bool {
		tools, err := db.ListMCPTools(context.Background(), store.ToolFilter{})
		return err == nil && len(tools) > 0
	})

	// /admin/mcp/servers
	srvResp, err := http.Get(proxy.URL + "/admin/mcp/servers")
	if err != nil {
		t.Fatal(err)
	}
	defer srvResp.Body.Close()
	var srvPayload struct {
		Servers []store.MCPServerStat `json:"servers"`
		Summary store.MCPSummary      `json:"summary"`
	}
	if err := json.NewDecoder(srvResp.Body).Decode(&srvPayload); err != nil {
		t.Fatal(err)
	}
	var github *store.MCPServerStat
	for i := range srvPayload.Servers {
		if srvPayload.Servers[i].ServerLabel == "github" {
			github = &srvPayload.Servers[i]
		}
	}
	if github == nil {
		t.Fatalf("expected github server in aggregates: %#v", srvPayload.Servers)
	}
	if !github.IsMCP {
		t.Error("expected github server flagged as MCP")
	}
	if github.Errors < 1 {
		t.Errorf("expected at least 1 error for github, got %d", github.Errors)
	}
	if srvPayload.Summary.TotalCalls < 1 {
		t.Errorf("expected total_calls >= 1, got %d", srvPayload.Summary.TotalCalls)
	}
	if srvPayload.Summary.MCPServers < 1 {
		t.Errorf("expected mcp_servers >= 1, got %d", srvPayload.Summary.MCPServers)
	}

	// /admin/mcp/tools
	toolsResp, err := http.Get(proxy.URL + "/admin/mcp/tools")
	if err != nil {
		t.Fatal(err)
	}
	defer toolsResp.Body.Close()
	var toolsPayload struct {
		Tools []store.MCPToolStat `json:"tools"`
	}
	if err := json.NewDecoder(toolsResp.Body).Decode(&toolsPayload); err != nil {
		t.Fatal(err)
	}
	if len(toolsPayload.Tools) == 0 {
		t.Fatal("expected tool aggregates")
	}

	// /admin/mcp/requests drill-down by tool (errors only)
	drillResp, err := http.Get(proxy.URL + "/admin/mcp/requests?server=github&tool=create_issue&errors=1")
	if err != nil {
		t.Fatal(err)
	}
	defer drillResp.Body.Close()
	var drill struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(drillResp.Body).Decode(&drill); err != nil {
		t.Fatal(err)
	}
	if len(drill.Requests) == 0 {
		t.Fatal("expected at least one request in tool error drill-down")
	}

	// request detail should expose tool invocations + spans
	reqID := drill.Requests[0].ID
	detailResp, err := http.Get(proxy.URL + "/admin/requests/" + reqID)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	var detail store.RequestDetail
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Tools) == 0 {
		t.Fatal("expected tools in request detail")
	}
	var hasToolSpan bool
	for _, sp := range detail.Spans {
		if sp.Kind == "mcp" || sp.Kind == "tool" {
			hasToolSpan = true
		}
	}
	if !hasToolSpan {
		t.Fatalf("expected an mcp/tool span, got %#v", detail.Spans)
	}
	// tools.no_error evaluation should have failed
	var found bool
	for _, e := range detail.Evaluations {
		if e.Name == "tools.no_error" {
			found = true
			if e.Passed {
				t.Error("expected tools.no_error to fail given the 403 tool result")
			}
		}
	}
	if !found {
		t.Error("expected tools.no_error evaluation to be present")
	}
}
