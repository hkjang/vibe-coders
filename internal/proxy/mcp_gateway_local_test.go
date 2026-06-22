package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func gwDispatch(t *testing.T, method, params string) *rpcResponse {
	t.Helper()
	s := &Server{}
	req := httptest.NewRequest("POST", "/mcp/gateway", nil)
	body := `{"jsonrpc":"2.0","id":1,"method":"` + method + `"`
	if params != "" {
		body += `,"params":` + params
	}
	body += `}`
	return s.dispatchGatewayMCP(req, "", nil, json.RawMessage(body))
}

func TestGatewayMCPInitializeAndLists(t *testing.T) {
	init := gwDispatch(t, "initialize", "")
	if init == nil || init.Error != nil {
		t.Fatalf("initialize failed: %+v", init)
	}
	if !strings.Contains(string(init.Result), "vibe-coders-gateway") {
		t.Fatalf("initialize serverInfo missing: %s", init.Result)
	}

	// tools/list — must advertise the read-only tool set.
	tl := gwDispatch(t, "tools/list", "")
	if tl == nil || tl.Error != nil {
		t.Fatalf("tools/list failed: %+v", tl)
	}
	for _, name := range []string{"gateway_chat", "gateway_run_skill", "gateway_run_text2sql_preview", "gateway_run_saved_report", "gateway_create_app_run", "gateway_run_workflow", "gateway_list_models", "gateway_route_preview", "gateway_explain_request", "gateway_get_usage_summary"} {
		if !strings.Contains(string(tl.Result), name) {
			t.Errorf("tools/list missing %q", name)
		}
	}

	// resources/list + prompts/list non-empty.
	if rl := gwDispatch(t, "resources/list", ""); rl == nil || !strings.Contains(string(rl.Result), "gateway://models") {
		t.Errorf("resources/list missing gateway://models: %+v", rl)
	}
	if pl := gwDispatch(t, "prompts/list", ""); pl == nil || !strings.Contains(string(pl.Result), "use_gateway_safely") {
		t.Errorf("prompts/list missing prompt: %+v", pl)
	}
}

// Every advertised gateway tool must have a published contract, and vice versa — so a tool can't
// ship without declaring its risk/cost/timeout/output contract.
func TestGatewayToolContractsCoverAllTools(t *testing.T) {
	contracts := map[string]gatewayToolContract{}
	for _, c := range gatewayToolContracts() {
		if c.RiskLevel != "low" && c.RiskLevel != "medium" && c.RiskLevel != "high" {
			t.Errorf("contract %q has invalid risk_level %q", c.Name, c.RiskLevel)
		}
		if c.TimeoutMS <= 0 || c.CostPolicy == "" || c.OutputSchema == "" {
			t.Errorf("contract %q is incomplete: %+v", c.Name, c)
		}
		contracts[c.Name] = c
	}
	tools := map[string]bool{}
	for _, td := range gatewayToolDefs() {
		tools[td.Name] = true
		if _, ok := contracts[td.Name]; !ok {
			t.Errorf("tool %q advertised but has no contract", td.Name)
		}
	}
	for name := range contracts {
		if !tools[name] {
			t.Errorf("contract %q has no advertised tool", name)
		}
	}
}

// JSON-RPC edge cases: malformed body, notification (no id), unknown tool.
func TestGatewayMCPEdgeCases(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest("POST", "/mcp/gateway", nil)

	// Malformed JSON → parse error -32700.
	if resp := s.dispatchGatewayMCP(req, "", nil, json.RawMessage(`{not json`)); resp == nil || resp.Error == nil || resp.Error.Code != -32700 {
		t.Fatalf("malformed body should be -32700, got %+v", resp)
	}
	// Notification (id null) for an unknown method → no response.
	if resp := s.dispatchGatewayMCP(req, "", nil, json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); resp != nil {
		t.Fatalf("notification should yield nil response, got %+v", resp)
	}
	// Unknown tool name → runGatewayTool errors (no DB access on this path).
	if _, err := s.runGatewayTool(req.Context(), req, "", nil, "gateway_nonexistent", json.RawMessage(`{}`)); err == nil {
		t.Fatal("unknown tool should return an error")
	}
}

func TestGatewayMCPPromptsGet(t *testing.T) {
	ok := gwDispatch(t, "prompts/get", `{"name":"choose_best_model"}`)
	if ok == nil || ok.Error != nil || !strings.Contains(string(ok.Result), "모델") {
		t.Fatalf("prompts/get should return text: %+v", ok)
	}
	bad := gwDispatch(t, "prompts/get", `{"name":"nope"}`)
	if bad == nil || bad.Error == nil {
		t.Fatalf("unknown prompt should error: %+v", bad)
	}
	unknown := gwDispatch(t, "frobnicate", "")
	if unknown == nil || unknown.Error == nil || unknown.Error.Code != -32601 {
		t.Fatalf("unknown method should be -32601: %+v", unknown)
	}
}
