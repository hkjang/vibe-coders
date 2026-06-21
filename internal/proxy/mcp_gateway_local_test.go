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
	for _, name := range []string{"gateway_chat", "gateway_list_models", "gateway_route_preview", "gateway_explain_request", "gateway_get_usage_summary"} {
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
