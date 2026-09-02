package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMCPGatewayPublicFailuresDiscardUpstreamDetails(t *testing.T) {
	const (
		unsafeName  = "legacy,mcp-errors"
		bodySecret  = "credential-from-mcp-http-body"
		querySecret = "credential-from-mcp-query"
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if len(request.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{}})
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"tools": []map[string]any{{"name": "lookup"}}}})
		case "resources/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"resources": []map[string]any{{"uri": "doc://safe", "name": "safe"}}}})
		case "resources/templates/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"resourceTemplates": []any{}}})
		case "prompts/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"prompts": []map[string]any{{"name": "safe-prompt"}}}})
		default:
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, `{"error":"`+bodySecret+`","url":"`+r.URL.String()+`"}`)
		}
	}))
	defer upstream.Close()

	server, db := newKnowledgeServer(t)
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-errors", Name: unsafeName, URL: upstream.URL + "?token=" + querySecret, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	list := mcpRPC(t, gateway.URL+"/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if list.Error != nil || !bytes.Contains(list.Result, []byte("legacy-errors__lookup")) {
		t.Fatalf("failed to initialize public routes: %+v", list)
	}
	tests := []struct {
		name    string
		payload string
		tool    string
	}{
		{name: "tool", payload: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"legacy-errors__lookup","arguments":{}}}`, tool: "lookup"},
		{name: "resource", payload: `{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"doc://safe"}}`, tool: "resources/read"},
		{name: "prompt", payload: `{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"legacy-errors__safe-prompt","arguments":{}}}`, tool: "safe-prompt"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := mcpRPC(t, gateway.URL+"/mcp", test.payload)
			if response.Error == nil || response.Error.Code != -32603 || response.Error.Message != mcpUpstreamRequestFailed {
				t.Fatalf("unexpected public error: %+v", response.Error)
			}
			visible, _ := json.Marshal(response)
			for _, secret := range []string{unsafeName, bodySecret, querySecret, "token="} {
				if bytes.Contains(visible, []byte(secret)) {
					t.Fatalf("public %s error leaked %q: %s", test.name, secret, visible)
				}
			}

			waitFor(t, 2*time.Second, func() bool {
				requests, err := db.RequestsForTool(t.Context(), unsafeName, test.tool, true, 20)
				if err != nil || len(requests) == 0 {
					return false
				}
				decisions, err := db.MCPRouteDecisionsForRequest(t.Context(), requests[0].ID)
				if err != nil || len(decisions) == 0 {
					return false
				}
				last := decisions[len(decisions)-1]
				return last.UpstreamName == unsafeName && last.Reason == mcpUpstreamRequestFailed
			})
		})
	}

	server.client.Transport = modelsRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("dial " + request.URL.String() + ": " + bodySecret)
	})
	server.resetMCPUpstream("legacy-errors")
	_, err := server.callUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-errors", Name: unsafeName, URL: "https://mcp.invalid/?token=" + querySecret, Enabled: true,
	}, "tools/list", map[string]any{})
	if err == nil || err.Error() != mcpUpstreamRequestFailed {
		t.Fatalf("transport error was not stable: %v", err)
	}
}

func TestMCPRPCErrorProjectionBoundsEveryRawPolicyServer(t *testing.T) {
	const (
		routeServer   = "route,mcp-server"
		blockedServer = "blocked,mcp-server"
	)
	response := projectMCPRPCErrorForExternal(
		rpcErrorResponse(json.RawMessage("1"), -32000, "blocked "+routeServer+" by "+blockedServer),
		routeServer,
		blockedServer,
	)
	visible, _ := json.Marshal(response)
	if bytes.Contains(visible, []byte(routeServer)) || bytes.Contains(visible, []byte(blockedServer)) {
		t.Fatalf("policy error retained a raw MCP server: %s", visible)
	}
	if got := strings.Count(string(visible), boundedModelsProviderLabel(routeServer)); got != 2 {
		t.Fatalf("policy error did not bound both server names: %s", visible)
	}
}

func TestMCPGroundedCachedDiscoveryErrorIsBounded(t *testing.T) {
	const (
		unsafeName  = "legacy,mcp-discovery"
		bodySecret  = "credential-from-discovery-body"
		querySecret = "credential-from-discovery-query"
	)
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, bodySecret)
	}))
	defer upstream.Close()

	server, db := newKnowledgeServer(t)
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-discovery", Name: unsafeName, URL: upstream.URL + "?api_key=" + querySecret, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description: "grounded search evidence", Domains: []string{"research"}, RiskLevel: "low",
			AllowedModels: []string{"vibe/grounded"}, DefaultTool: "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	requestBody := map[string]any{
		"model":    "vibe/grounded",
		"messages": []map[string]string{{"role": "user", "content": "grounded search evidence"}},
	}
	check := func() {
		response := postJSON(t, gateway.URL+"/v1/chat/completions", "", requestBody)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("grounded response status=%d body=%s", response.StatusCode, body)
		}
		visible := string(body)
		for _, secret := range []string{unsafeName, bodySecret, querySecret, "api_key"} {
			if strings.Contains(visible, secret) {
				t.Fatalf("cached discovery response leaked %q: %s", secret, visible)
			}
		}
		if !strings.Contains(visible, boundedModelsProviderLabel(unsafeName)) || !strings.Contains(visible, mcpUpstreamRequestFailed) {
			t.Fatalf("grounded response omitted bounded stable diagnostics: %s", visible)
		}
	}
	check()
	firstCalls := calls.Load()
	if firstCalls == 0 {
		t.Fatal("expected a live discovery attempt")
	}
	check()
	if got := calls.Load(); got != firstCalls {
		t.Fatalf("second grounded request bypassed discovery cache: first=%d second=%d", firstCalls, got)
	}
	snapshot := server.mcpTools.Load()
	if snapshot == nil || snapshot.errors[unsafeName] != mcpUpstreamRequestFailed {
		t.Fatalf("cached error was not stable while raw identity stayed internal: %+v", snapshot)
	}
}

func TestMCPUnsafeLegacyNameIsProjectedAcrossPublicSurfaces(t *testing.T) {
	const unsafeName = "legacy,mcp-display"
	mcpUpstream := fakeMCPUpstream(t)
	defer mcpUpstream.Close()

	server, db := newKnowledgeServer(t)
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-mcp", Name: unsafeName, URL: mcpUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description: "echo evidence search", Domains: []string{"research"}, RiskLevel: "low",
			AllowedModels: []string{"vibe/grounded"}, DefaultTool: "echo",
		},
	}); err != nil {
		t.Fatal(err)
	}

	for _, request := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"prompts/list"}`,
	} {
		response := mcpRPC(t, gateway.URL+"/mcp", request)
		visible, _ := json.Marshal(response)
		if bytes.Contains(visible, []byte(unsafeName)) || !bytes.Contains(visible, []byte(boundedModelsProviderLabel(unsafeName))) {
			t.Fatalf("MCP catalog did not project unsafe display name: %s", visible)
		}
	}

	staticResponse := postJSON(t, gateway.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "vibe/grounded",
		"messages": []map[string]string{{"role": "user", "content": "echo evidence search"}},
	})
	staticBody, _ := io.ReadAll(staticResponse.Body)
	staticResponse.Body.Close()
	if staticResponse.StatusCode != http.StatusOK || bytes.Contains(staticBody, []byte(unsafeName)) || !bytes.Contains(staticBody, []byte(boundedModelsProviderLabel(unsafeName))) {
		t.Fatalf("static evidence did not project unsafe display name: status=%d body=%s", staticResponse.StatusCode, staticBody)
	}
	var staticResult struct {
		Evidence []MCPEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(staticBody, &staticResult); err != nil || len(staticResult.Evidence) != 1 ||
		staticResult.Evidence[0].UpstreamName != boundedModelsProviderLabel(unsafeName) {
		t.Fatalf("structured evidence did not use the bounded label: evidence=%+v err=%v", staticResult.Evidence, err)
	}

	var llmCalls atomic.Int64
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), `"role":"tool"`) || llmCalls.Load() > 0 {
			llmCalls.Add(1)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"grounded answer"},"finish_reason":"stop"}]}`)
			return
		}
		llmCalls.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"legacy-mcp__echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
	}))
	defer llm.Close()
	providerResponse := postJSON(t, gateway.URL+"/admin/providers", "", map[string]any{
		"name": "safe-llm", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "qwen-plus",
	})
	providerBody, _ := io.ReadAll(providerResponse.Body)
	providerResponse.Body.Close()
	if providerResponse.StatusCode != http.StatusOK {
		t.Fatalf("provider setup status=%d body=%s", providerResponse.StatusCode, providerBody)
	}
	mcpConfig := server.mcpConf()
	mcpConfig.AgenticModel = "qwen-plus"
	server.mcpRuntime.Store(&mcpConfig)
	streamResponse := postJSON(t, gateway.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/grounded", "stream": true,
		"messages": []map[string]string{{"role": "user", "content": "echo evidence search"}},
	})
	streamBody, _ := io.ReadAll(streamResponse.Body)
	streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK || !strings.Contains(streamResponse.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("agentic stream status=%d content-type=%q body=%s", streamResponse.StatusCode, streamResponse.Header.Get("Content-Type"), streamBody)
	}
	if bytes.Contains(streamBody, []byte(unsafeName)) || !bytes.Contains(streamBody, []byte(boundedModelsProviderLabel(unsafeName))) {
		t.Fatalf("SSE did not project unsafe display name: %s", streamBody)
	}
	if err := db.UpsertToolRiskProfile(t.Context(), store.ToolRiskProfile{
		ID: "risk_legacy_mcp", ServerLabel: unsafeName, ToolName: "echo",
		RiskLevel: "critical", Action: "block",
	}); err != nil {
		t.Fatal(err)
	}
	llmCalls.Store(0)
	blockedStream := postJSON(t, gateway.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/grounded", "stream": true,
		"messages": []map[string]string{{"role": "user", "content": "echo evidence search"}},
	})
	blockedBody, _ := io.ReadAll(blockedStream.Body)
	blockedStream.Body.Close()
	if blockedStream.StatusCode != http.StatusOK || bytes.Contains(blockedBody, []byte(unsafeName)) ||
		!bytes.Contains(blockedBody, []byte(boundedModelsProviderLabel(unsafeName))) || !bytes.Contains(blockedBody, []byte("오류")) {
		t.Fatalf("governance SSE leaked an unsafe display name: status=%d body=%s", blockedStream.StatusCode, blockedBody)
	}

	const apiKey = "mcp-receipt-key"
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "key_mcp_receipt", Name: "receipt", KeyHash: hashProxyKey(apiKey), UserID: "user_mcp_receipt", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: "req_mcp_receipt", TraceID: "trace_mcp_receipt", APIKeyID: "key_mcp_receipt",
			Endpoint: "/mcp", Model: "mcp:" + unsafeName, Provider: unsafeName,
			StatusCode: http.StatusOK, CreatedAt: time.Now().UTC(),
		},
		Tools: []store.ToolInvocation{{
			ID: "tool_mcp_receipt", RequestID: "req_mcp_receipt", TraceID: "trace_mcp_receipt",
			APIKeyID: "key_mcp_receipt", ServerLabel: unsafeName, ToolName: "echo", IsMCP: true, CreatedAt: time.Now().UTC(),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	receiptRequest, _ := http.NewRequest(http.MethodGet, gateway.URL+"/me/requests/req_mcp_receipt/receipt", nil)
	receiptRequest.Header.Set("Authorization", "Bearer "+apiKey)
	receiptResponse, err := http.DefaultClient.Do(receiptRequest)
	if err != nil {
		t.Fatal(err)
	}
	receiptBody, _ := io.ReadAll(receiptResponse.Body)
	receiptResponse.Body.Close()
	if receiptResponse.StatusCode != http.StatusOK || bytes.Contains(receiptBody, []byte(unsafeName)) || !bytes.Contains(receiptBody, []byte(boundedModelsProviderLabel(unsafeName))) {
		t.Fatalf("receipt did not project unsafe MCP name: status=%d body=%s", receiptResponse.StatusCode, receiptBody)
	}

	tools, err := db.ToolsForRequest(context.Background(), "req_mcp_receipt")
	if err != nil || len(tools) != 1 || tools[0].ServerLabel != unsafeName {
		t.Fatalf("external projection mutated internal MCP identity: tools=%+v err=%v", tools, err)
	}
}

func TestMCPUpstreamNameAdmissionPreservesExactLegacyEdit(t *testing.T) {
	const unsafeName = "legacy,mcp-name"
	server, db := newKnowledgeServer(t)
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()

	create := postJSON(t, gateway.URL+"/admin/mcp/upstreams", "", map[string]any{
		"id": "new-unsafe", "name": unsafeName, "url": "https://mcp.invalid", "enabled": false,
	})
	createBody, _ := io.ReadAll(create.Body)
	create.Body.Close()
	if create.StatusCode != http.StatusBadRequest || !bytes.Contains(createBody, []byte("mcp_upstream_name_invalid")) {
		t.Fatalf("unsafe name admission status=%d body=%s", create.StatusCode, createBody)
	}
	if _, found, err := db.GetMCPUpstream(t.Context(), "new-unsafe"); err != nil || found {
		t.Fatalf("unsafe upstream was persisted: found=%v err=%v", found, err)
	}
	reservedName := boundedModelsProviderLabel(unsafeName)
	reserved := postJSON(t, gateway.URL+"/admin/mcp/upstreams", "", map[string]any{
		"id": "new-reserved", "name": reservedName, "url": "https://mcp.invalid", "enabled": false,
	})
	reservedBody, _ := io.ReadAll(reserved.Body)
	reserved.Body.Close()
	if reserved.StatusCode != http.StatusBadRequest || !bytes.Contains(reservedBody, []byte("mcp_upstream_name_reserved")) {
		t.Fatalf("reserved name admission status=%d body=%s", reserved.StatusCode, reservedBody)
	}

	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-row", Name: unsafeName, URL: "https://legacy.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	legacyEdit := patchJSON(t, gateway.URL+"/admin/mcp/upstreams/legacy-row", "", map[string]any{
		"name": unsafeName, "enabled": false,
	})
	legacyBody, _ := io.ReadAll(legacyEdit.Body)
	legacyEdit.Body.Close()
	if legacyEdit.StatusCode != http.StatusOK || !bytes.Contains(legacyBody, []byte(unsafeName)) {
		t.Fatalf("exact legacy edit changed /admin shape: status=%d body=%s", legacyEdit.StatusCode, legacyBody)
	}
	stored, found, err := db.GetMCPUpstream(t.Context(), "legacy-row")
	if err != nil || !found || stored.Name != unsafeName || stored.Enabled {
		t.Fatalf("legacy unrelated edit was not preserved: upstream=%+v found=%v err=%v", stored, found, err)
	}

	rename := patchJSON(t, gateway.URL+"/admin/mcp/upstreams/legacy-row", "", map[string]any{"name": "other,unsafe-name"})
	renameBody, _ := io.ReadAll(rename.Body)
	rename.Body.Close()
	if rename.StatusCode != http.StatusBadRequest || !bytes.Contains(renameBody, []byte("mcp_upstream_name_invalid")) {
		t.Fatalf("unsafe legacy rename status=%d body=%s", rename.StatusCode, renameBody)
	}
	stored, _, _ = db.GetMCPUpstream(t.Context(), "legacy-row")
	if stored.Name != unsafeName {
		t.Fatalf("rejected rename mutated legacy row: %+v", stored)
	}
	reservedRename := patchJSON(t, gateway.URL+"/admin/mcp/upstreams/legacy-row", "", map[string]any{"name": reservedName})
	reservedRenameBody, _ := io.ReadAll(reservedRename.Body)
	reservedRename.Body.Close()
	if reservedRename.StatusCode != http.StatusBadRequest || !bytes.Contains(reservedRenameBody, []byte("mcp_upstream_name_reserved")) {
		t.Fatalf("reserved legacy rename status=%d body=%s", reservedRename.StatusCode, reservedRenameBody)
	}
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legacy-reserved", Name: reservedName, URL: "https://legacy-reserved.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	reservedLegacyEdit := patchJSON(t, gateway.URL+"/admin/mcp/upstreams/legacy-reserved", "", map[string]any{"enabled": false})
	reservedLegacyBody, _ := io.ReadAll(reservedLegacyEdit.Body)
	reservedLegacyEdit.Body.Close()
	if reservedLegacyEdit.StatusCode != http.StatusOK || !bytes.Contains(reservedLegacyBody, []byte(reservedName)) {
		t.Fatalf("exact reserved legacy edit changed /admin shape: status=%d body=%s", reservedLegacyEdit.StatusCode, reservedLegacyBody)
	}
}

func TestMCPGroundedDatabaseFailureIsStable(t *testing.T) {
	server, db := newKnowledgeServer(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	body := []byte(`{
		"model":"vibe/grounded",
		"messages":[{"role":"user","content":"lookup evidence"}]
	}`)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	server.handleMCPDiscoveryChat(recorder, request, body, "lookup evidence", mcpDiscoveryPolicyForModel("vibe/grounded"), "test-key", nil)

	visible := recorder.Body.String()
	if recorder.Code != http.StatusBadGateway || !strings.Contains(visible, `"code":"mcp_discovery_failed"`) ||
		!strings.Contains(visible, "MCP discovery is unavailable") {
		t.Fatalf("unexpected grounded database failure: status=%d body=%s", recorder.Code, visible)
	}
	for _, internal := range []string{"database is closed", "sql:", "SELECT", "mcp_upstreams"} {
		if strings.Contains(visible, internal) {
			t.Fatalf("grounded database failure leaked %q: %s", internal, visible)
		}
	}
}
