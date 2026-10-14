package proxy

func enrichMCPTopologyOpenAPI(op, responses map[string]any) {
	op["description"] = "Read-only MCP topology requiring observability:read when authentication is enabled. Nodes describe the gateway, configured upstreams and cached discovered routes, not agent relationships or live calls. Configuration, discovery and current policy decisions are separate reads, not an atomic snapshot. Enabled/disabled is configuration, not health. Edges use from/to node IDs; cache/config timing can leave missing endpoints. Consumers must not silently invent endpoints or merge duplicate IDs. No server pagination. A configuration-read failure returns 503, not an empty topology."
	responses["200"] = successResponse("McpTopologyResponse")
	for status, description := range map[string]string{"401": "Invalid authentication or missing observability:read scope (existing admin authorization behavior)", "405": "GET required", "503": "MCP topology configuration unavailable"} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func mcpTopologyOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	identifier := map[string]any{"type": "string", "minLength": 1}
	return map[string]any{
		"McpTopologyResponse": map[string]any{"type": "object", "required": []string{"nodes", "edges"}, "properties": map[string]any{
			"nodes": map[string]any{"type": "array", "items": schemaRef("McpTopologyNode")},
			"edges": map[string]any{"type": "array", "items": schemaRef("McpTopologyEdge")},
		}},
		"McpTopologyNode": map[string]any{"type": "object", "required": []string{"id", "label", "kind"}, "properties": map[string]any{
			"id": identifier, "label": text, "kind": identifier, "status": text, "decision": text,
		}},
		"McpTopologyEdge": map[string]any{"type": "object", "required": []string{"from", "to", "label"}, "properties": map[string]any{
			"from": identifier, "to": identifier, "label": text,
		}},
	}
}
