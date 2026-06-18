package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// fakeMCPUpstream is a minimal JSON-RPC MCP server exposing two tools.
func fakeMCPUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if len(req.ID) == 0 { // notification (e.g. notifications/initialized)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "sess-fake-1")
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		switch req.Method {
		case "initialize":
			resp["result"] = map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "fake", "version": "1"},
			}
		case "tools/list":
			resp["result"] = map[string]any{"tools": []map[string]any{
				{"name": "echo", "description": "Echo text", "inputSchema": map[string]any{"type": "object"}},
				{"name": "add", "description": "Add numbers"},
			}}
		case "tools/call":
			var p struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(req.Params, &p)
			resp["result"] = map[string]any{
				"content": []map[string]any{{"type": "text", "text": "called " + p.Name}},
				"isError": false,
			}
		case "resources/list":
			resp["result"] = map[string]any{"resources": []map[string]any{
				{"uri": "file:///README.md", "name": "README", "mimeType": "text/markdown"},
			}}
		case "resources/templates/list":
			resp["result"] = map[string]any{"resourceTemplates": []map[string]any{
				{"uriTemplate": "file:///{path}", "name": "file"},
			}}
		case "resources/read":
			var p struct {
				URI string `json:"uri"`
			}
			_ = json.Unmarshal(req.Params, &p)
			resp["result"] = map[string]any{"contents": []map[string]any{{"uri": p.URI, "text": "contents of " + p.URI}}}
		case "prompts/list":
			resp["result"] = map[string]any{"prompts": []map[string]any{
				{"name": "summarize", "description": "Summarize text"},
			}}
		case "prompts/get":
			var p struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(req.Params, &p)
			resp["result"] = map[string]any{"description": "got " + p.Name, "messages": []map[string]any{}}
		default:
			resp["error"] = map[string]any{"code": -32601, "message": "method not found"}
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

func mcpRPC(t *testing.T, url, payload string) rpcResponse {
	t.Helper()
	resp, err := http.Post(url, "application/json", bytes.NewReader([]byte(payload)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode rpc response: %v", err)
	}
	return out
}

func TestMCPGatewayAggregatesNamespacesRoutes(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t) // builds a Server + store
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}

	// initialize handshake
	init := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if init.Error != nil || init.Result == nil {
		t.Fatalf("initialize failed: %+v", init)
	}

	// tools/list → namespaced, aggregated
	list := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if list.Error != nil {
		t.Fatalf("tools/list error: %+v", list.Error)
	}
	var lr struct {
		Tools []mcpToolDef `json:"tools"`
	}
	if err := json.Unmarshal(list.Result, &lr); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tl := range lr.Tools {
		names[tl.Name] = true
	}
	if !names["fake__echo"] || !names["fake__add"] {
		t.Fatalf("expected namespaced tools fake__echo/fake__add, got %v", names)
	}

	// tools/call → routed to the upstream with the bare tool name
	call := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fake__echo","arguments":{"text":"hi"}}}`)
	if call.Error != nil {
		t.Fatalf("tools/call error: %+v", call.Error)
	}
	if !bytes.Contains(call.Result, []byte("called echo")) {
		t.Fatalf("unexpected tools/call result: %s", call.Result)
	}

	// unknown tool → JSON-RPC error
	bad := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope__x"}}`)
	if bad.Error == nil {
		t.Fatalf("expected error for unknown tool")
	}

	// the routed call was logged into the unified MCP observability pipeline
	waitFor(t, 2*time.Second, func() bool {
		servers, _ := db.ListMCPServers(ctx, store.ToolFilter{})
		for _, sv := range servers {
			if sv.ServerLabel == "fake" && sv.Calls >= 1 {
				return true
			}
		}
		return false
	})
}

func TestMCPGatewayResourcesAndPrompts(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	if err := db.UpsertMCPUpstream(context.Background(), store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}

	// initialize advertises resources + prompts capabilities
	init := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if !bytes.Contains(init.Result, []byte("resources")) || !bytes.Contains(init.Result, []byte("prompts")) {
		t.Fatalf("initialize should advertise resources+prompts: %s", init.Result)
	}

	// resources/list aggregates (original URI preserved), resources/read routes
	rl := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":2,"method":"resources/list"}`)
	if !bytes.Contains(rl.Result, []byte("file:///README.md")) {
		t.Fatalf("resources/list missing resource: %s", rl.Result)
	}
	rr := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"file:///README.md"}}`)
	if rr.Error != nil || !bytes.Contains(rr.Result, []byte("contents of file:///README.md")) {
		t.Fatalf("resources/read failed: %+v", rr)
	}
	if bad := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"file:///nope"}}`); bad.Error == nil {
		t.Fatalf("expected error for unknown resource")
	}

	// templates aggregate
	rt := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":5,"method":"resources/templates/list"}`)
	if !bytes.Contains(rt.Result, []byte("uriTemplate")) {
		t.Fatalf("resources/templates/list missing template: %s", rt.Result)
	}

	// prompts/list is namespaced, prompts/get routes by namespaced name
	pl := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":6,"method":"prompts/list"}`)
	if !bytes.Contains(pl.Result, []byte("fake__summarize")) {
		t.Fatalf("prompts/list not namespaced: %s", pl.Result)
	}
	pg := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":7,"method":"prompts/get","params":{"name":"fake__summarize","arguments":{}}}`)
	if pg.Error != nil || !bytes.Contains(pg.Result, []byte("got summarize")) {
		t.Fatalf("prompts/get failed (should strip namespace to 'summarize'): %+v", pg)
	}
}

func TestMCPUpstreamProbe(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	if err := db.UpsertMCPUpstream(context.Background(), store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(proxy.URL + "/admin/mcp/upstreams/fake/probe")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("probe status %d", resp.StatusCode)
	}
	var out struct {
		OK        bool `json:"ok"`
		ToolCount int  `json:"tool_count"`
		Tools     []struct {
			Name       string `json:"name"`
			Namespaced string `json:"namespaced"`
		} `json:"tools"`
		ResourceCount int `json:"resource_count"`
		PromptCount   int `json:"prompt_count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.ToolCount != 2 {
		t.Fatalf("probe expected ok + 2 tools, got ok=%v count=%d", out.OK, out.ToolCount)
	}
	if out.ResourceCount != 1 || out.PromptCount != 1 {
		t.Fatalf("probe expected 1 resource + 1 prompt, got %d/%d", out.ResourceCount, out.PromptCount)
	}
	found := false
	for _, tl := range out.Tools {
		if tl.Name == "echo" && tl.Namespaced == "fake__echo" {
			found = true
		}
	}
	if !found {
		t.Fatalf("probe should report echo tool with namespaced name, got %+v", out.Tools)
	}
}

func TestMCPGatewayPolicyBlocks(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPPolicy(ctx, store.MCPPolicy{ServerLabel: "fake", Mode: "block"}); err != nil {
		t.Fatal(err)
	}

	call := mcpRPC(t, proxy.URL+"/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fake__echo","arguments":{}}}`)
	if call.Error == nil {
		t.Fatalf("expected policy block error, got result: %s", call.Result)
	}
}

func TestMCPAdminConsoleRoutesExplainAndTest(t *testing.T) {
	up := fakeMCPUpstream(t)
	defer up.Close()
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "fake", Name: "fake", URL: up.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "off", Name: "off", URL: up.URL, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertToolRiskProfile(ctx, store.ToolRiskProfile{ID: "trp1", ServerLabel: "fake", ToolName: "echo", RiskLevel: "high", Action: "require_approval", Note: "writes issue"}); err != nil {
		t.Fatal(err)
	}

	routesResp, err := http.Get(proxy.URL + "/admin/mcp/routes")
	if err != nil {
		t.Fatal(err)
	}
	defer routesResp.Body.Close()
	if routesResp.StatusCode != http.StatusOK {
		t.Fatalf("routes status %d", routesResp.StatusCode)
	}
	var routesOut struct {
		Routes []mcpRouteView `json:"routes"`
	}
	if err := json.NewDecoder(routesResp.Body).Decode(&routesOut); err != nil {
		t.Fatal(err)
	}
	hasTool := false
	hasDisabled := false
	for _, r := range routesOut.Routes {
		if r.Kind == "tool" && r.ExposedName == "fake__echo" && r.TargetName == "echo" && r.UpstreamID == "fake" {
			hasTool = true
		}
		if r.UpstreamID == "off" {
			hasDisabled = true
		}
	}
	if !hasTool {
		t.Fatalf("expected fake__echo route, got %+v", routesOut.Routes)
	}
	if hasDisabled {
		t.Fatalf("disabled upstream must not appear in route map: %+v", routesOut.Routes)
	}

	explainResp := postJSON(t, proxy.URL+"/admin/mcp/route/explain", "", map[string]any{
		"method": "tools/call",
		"name":   "fake__echo",
	})
	defer explainResp.Body.Close()
	var explain map[string]any
	if err := json.NewDecoder(explainResp.Body).Decode(&explain); err != nil {
		t.Fatal(err)
	}
	final := explain["final"].(map[string]any)
	if final["decision"] != "approval_required" {
		t.Fatalf("expected approval_required, got %+v", explain)
	}
	policy := explain["policy"].(map[string]any)
	if policy["tool_risk_level"] != "high" || policy["tool_risk_action"] != "require_approval" {
		t.Fatalf("risk profile not reflected: %+v", explain)
	}

	testResp := postJSON(t, proxy.URL+"/admin/mcp/test", "", map[string]any{
		"method":      "tools/call",
		"upstream_id": "fake",
		"name":        "fake__echo",
		"arguments":   map[string]any{"text": "hi"},
	})
	defer testResp.Body.Close()
	var tested struct {
		OK              bool   `json:"ok"`
		ResponsePreview string `json:"response_preview"`
	}
	if err := json.NewDecoder(testResp.Body).Decode(&tested); err != nil {
		t.Fatal(err)
	}
	if !tested.OK || !strings.Contains(tested.ResponsePreview, "called echo") {
		t.Fatalf("expected successful test call, got %+v", tested)
	}
}
