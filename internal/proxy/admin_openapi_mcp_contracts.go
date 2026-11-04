package proxy

func enrichMCPContractsOpenAPI(key string, op, responses map[string]any) {
	op["description"] = "Existing MCP declaration registry. GET requires observability:read; POST and DELETE require mcp:admin when authentication is enabled. Editing replaces all fields by ID, including both schema strings; omission does not preserve a schema. Namespace/name are not a unique key. No revision/CAS or transactional audit guarantee. Declarations do not reconfigure the actual gateway tools."
	for _, status := range []string{"400", "401", "405", "500"} {
		responses[status] = map[string]any{"description": "Existing validation, authorization, method or storage error", "content": jsonContent(schemaRef("AppError"))}
	}
	switch key {
	case "get /admin/gateway-mcp/info":
		op["description"] = "Existing built-in gateway MCP information requiring admin:read. Published implementation contracts are distinct from stored registry declarations. This is not an upstream health check."
		responses["200"] = successResponse("GatewayMcpInfoResponse")
	case "get /admin/mcp/contracts":
		op["parameters"] = []any{
			map[string]any{"name": "namespace", "in": "query", "schema": map[string]any{"type": "string"}},
			map[string]any{"name": "enabled", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Exactly 1 selects enabled declarations."},
		}
		responses["200"] = successResponse("McpContractListResponse")
	case "post /admin/mcp/contracts":
		op["requestBody"] = requestBody("McpContractWriteRequest")
		responses["200"] = successResponse("McpContractSavedResponse")
	case "delete /admin/mcp/contracts":
		op["parameters"] = []any{map[string]any{"name": "id", "in": "query", "required": true, "schema": map[string]any{"type": "string", "minLength": 1}}}
		responses["200"] = successResponse("McpContractDeletedResponse")
	case "post /admin/mcp/contracts/validate":
		op["description"] = "Read-only local comparison requiring mcp:admin. Includes disabled declarations. Compares only top-level input properties names against built-in gateway tools, not nested types, output, permissions, cost, timeout or an upstream execution. Non-gateway namespaces are not_checkable. Malformed/empty JSON body currently falls back to all contracts. No writes or external calls."
		op["requestBody"] = requestBody("McpContractValidateRequest")
		responses["200"] = successResponse("McpContractValidationResponse")
		responses["404"] = map[string]any{"description": "Explicit contract ID not found", "content": jsonContent(schemaRef("AppError"))}
	}
}

func mcpContractsOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "format": "int64"}
	object := func(required []string, fields map[string]any) map[string]any {
		value := map[string]any{"type": "object", "properties": fields}
		if len(required) > 0 {
			value["required"] = required
		}
		return value
	}
	fields := func() map[string]any {
		return map[string]any{
			"id": text, "namespace": text, "name": text, "title": text, "description": text,
			"input_schema": text, "output_schema": text, "risk_level": text, "timeout_ms": count,
			"allowed_roles": text, "cost_policy": text, "owner": text, "enabled": flag,
		}
	}
	row := fields()
	row["created_by"], row["created_at"], row["updated_at"] = text, text, text
	required := []string{"id", "namespace", "name", "title", "description", "input_schema", "output_schema", "risk_level", "timeout_ms", "allowed_roles", "cost_policy", "owner", "enabled", "created_by", "created_at", "updated_at"}
	strings := map[string]any{"type": "array", "items": text}
	array := func(value map[string]any) map[string]any { return map[string]any{"type": "array", "items": value} }
	return map[string]any{
		"GatewayMcpInfoResponse": object([]string{"endpoint", "protocol_version", "note", "tools", "contracts", "resources", "prompts"}, map[string]any{
			"endpoint": text, "protocol_version": text, "note": text,
			"tools": array(object([]string{"name"}, map[string]any{"name": text, "description": text, "inputSchema": map[string]any{}})),
			"contracts": array(object([]string{"name", "risk_level", "cost_policy", "timeout_ms", "allowed_roles", "executes", "output_schema"}, map[string]any{
				"name": text, "risk_level": text, "cost_policy": text, "timeout_ms": count, "allowed_roles": text, "executes": flag, "output_schema": text,
			})),
			"resources": array(object([]string{"uri", "name"}, map[string]any{"uri": text, "name": text, "description": text, "mimeType": text})),
			"prompts":   array(object([]string{"name"}, map[string]any{"name": text, "description": text})),
		}),
		"McpContract":                object(required, row),
		"McpContractListResponse":    object([]string{"contracts"}, map[string]any{"contracts": map[string]any{"type": "array", "items": schemaRef("McpContract")}}),
		"McpContractWriteRequest":    object([]string{"name"}, fields()),
		"McpContractSavedResponse":   object([]string{"id", "ok"}, map[string]any{"id": text, "ok": flag}),
		"McpContractDeletedResponse": object([]string{"ok"}, map[string]any{"ok": flag}),
		"McpContractValidateRequest": object(nil, map[string]any{"namespace": text, "contract_id": text}),
		"McpContractValidationResponse": object([]string{"checked", "drift_count", "missing_count", "note", "results"}, map[string]any{
			"checked": count, "drift_count": count, "missing_count": count, "note": text,
			"results": map[string]any{"type": "array", "items": object([]string{"contract_id", "namespace", "name", "risk_level", "status"}, map[string]any{
				"contract_id": text, "namespace": text, "name": text, "risk_level": text, "status": text, "detail": text,
				"declared_only": strings, "live_only": strings,
			})},
		}),
	}
}
