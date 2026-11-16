package proxy

import "slices"

func enrichServiceSummaryOpenAPI(route string, op, responses map[string]any) {
	if route == "/admin/text2sql/summary" {
		op["description"] = "Metadata-only statistics using the existing Text2SQLStatsSinceScoped aggregate and checked caller team scope. Excludes shadow mode. valid_rate means validation passed / total, not execution success. No question, SQL, schema, credential or result content; performs no execution or mutation. GET only; no-store. window defaults to 24h and rejects duplicate, malformed or extra parameters. since is inclusive; generated_at is the observation start, not an exclusive upper bound."
		op["parameters"] = []any{map[string]any{"name": "window", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"1h", "24h", "7d", "30d"}, "default": "24h"}}}
		responses["200"] = successResponse("Text2SQLSummaryResponse")
	} else {
		op["description"] = "Existing global admin:read MCP overview. Recent counts aggregate all MCP tool records since the inclusive 24-hour lower bound, without the per-tool list's 500-row limit. recent_error_count counts error records including result records, not unique failed calls; the preserved recent_error_rate is errors/calls and can exceed one. summary retains the legacy all-tool, all-time semantics. healthy_upstream_count counts upstreams with discovered routes, not a live connection probe. fetched_at is discovery time (may be zero); generated_at is the current statistics observation start, not an exclusive upper bound. Any storage failure returns a generic error instead of zero counts; no-store."
		responses["200"] = successResponse("MCPOverviewResponse")
	}
	for _, code := range []string{"400", "401", "403", "405", "500"} {
		responses[code] = map[string]any{"description": "Summary unavailable; no storage error or private context is echoed.", "content": jsonContent(schemaRef("AppError"))}
	}
}

func serviceSummaryOpenAPISchemas() map[string]any {
	count := map[string]any{"type": "integer", "minimum": 0}
	number := map[string]any{"type": "number", "minimum": 0}
	stamp := map[string]any{"type": "string", "format": "date-time"}
	object := func(fields map[string]any) map[string]any {
		required := make([]string, 0, len(fields))
		for key := range fields {
			required = append(required, key)
		}
		// Generated contracts must be deterministic across processes.
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	mcp := map[string]any{}
	for _, key := range []string{"upstream_count", "enabled_upstream_count", "healthy_upstream_count", "total_tools", "total_prompts", "total_resources", "discovery_error_count", "blocked_count", "recent_call_count", "recent_error_count"} {
		mcp[key] = count
	}
	mcp["recent_error_rate"] = number
	for _, key := range []string{"since", "generated_at", "fetched_at"} {
		mcp[key] = stamp
	}
	mcp["summary"] = object(map[string]any{"total_calls": count, "total_errors": count, "distinct_tools": count, "mcp_servers": count})
	return map[string]any{
		"MCPOverviewResponse": object(mcp),
		"Text2SQLSummaryResponse": object(map[string]any{
			"enabled": map[string]any{"type": "boolean"}, "window": map[string]any{"type": "string", "enum": []string{"1h", "24h", "7d", "30d"}}, "since": stamp, "generated_at": stamp,
			"stats": object(map[string]any{"total": count, "valid": count, "executed": count, "errors": count, "cost_krw": number, "valid_rate": map[string]any{"type": "number", "minimum": 0, "maximum": 1}}),
		}),
	}
}
