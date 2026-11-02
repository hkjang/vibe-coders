package proxy

func enrichMCPCallOpenAPI(route string, op, responses map[string]any) {
	op["description"] = "Existing administrator MCP operation requiring mcp:admin when authentication is enabled, including route explanation. Explanation uses discovery and current policy reads, not an atomic execution reservation. Test calls directly invoke an upstream; they do not enforce the normal gateway policy/approval pipeline, cost caps or per-operation audit. A test response with ok=false is still HTTP 200, and transport failure does not prove an external action was not executed."
	request, response := "McpRouteExplainRequest", "McpRouteExplainResponse"
	if route == "/admin/mcp/test" {
		request, response = "McpTestRequest", "McpTestResponse"
		responses["404"] = map[string]any{"description": "Upstream missing or disabled", "content": jsonContent(schemaRef("AppError"))}
	}
	op["requestBody"] = requestBody(request)
	responses["200"] = successResponse(response)
	for _, status := range []string{"400", "401", "405"} {
		responses[status] = map[string]any{"description": "Invalid body, authentication/scope, or method", "content": jsonContent(schemaRef("AppError"))}
	}
}

func mcpCallOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	object := func(required []string, properties map[string]any) map[string]any {
		out := map[string]any{"type": "object", "properties": properties}
		if len(required) > 0 {
			out["required"] = required
		}
		return out
	}
	return map[string]any{
		"McpRouteExplainRequest": object(nil, map[string]any{"method": text, "name": text, "uri": text, "api_key_id": text}),
		"McpRouteExplainResponse": object([]string{"input", "route", "final"}, map[string]any{
			"input":  object([]string{"method", "name", "uri"}, map[string]any{"method": text, "name": text, "uri": text}),
			"route":  object([]string{"found"}, map[string]any{"found": flag, "upstream_id": text, "upstream_name": text, "target_method": text, "target_name": text, "lookup": text}),
			"policy": object([]string{"server_policy", "tool_risk_level", "tool_risk_action", "tool_risk_configured", "tool_risk_note"}, map[string]any{"server_policy": text, "tool_risk_level": text, "tool_risk_action": text, "tool_risk_configured": flag, "tool_risk_note": text}),
			"final":  object([]string{"decision", "reason"}, map[string]any{"decision": text, "reason": text}),
		}),
		"McpTestRequest":  object(nil, map[string]any{"upstream_id": text, "method": text, "name": text, "uri": text, "arguments": map[string]any{}}),
		"McpTestResponse": object([]string{"upstream_id", "upstream_name", "method", "latency_ms", "ok"}, map[string]any{"upstream_id": text, "upstream_name": text, "method": text, "latency_ms": map[string]any{"type": "integer", "format": "int64"}, "ok": flag, "error": text, "response_preview": text, "response": map[string]any{}}),
	}
}
