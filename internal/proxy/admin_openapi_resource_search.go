package proxy

func resourceSearchOpenAPISchemas() map[string]any {
	kind := map[string]any{"type": "string", "enum": []string{"provider", "workflow", "app", "skill", "mcp_upstream"}}
	return map[string]any{
		"ResourceSearchRequest": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"query", "kinds"},
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "minLength": 2, "maxLength": 128},
				"kinds": map[string]any{"type": "array", "items": kind, "minItems": 1, "maxItems": 5, "uniqueItems": true},
			},
		},
		"ResourceSearchResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"groups", "request_id"},
			"properties": map[string]any{
				"request_id": map[string]any{"type": "string"},
				"groups": map[string]any{"type": "array", "maxItems": 5, "items": map[string]any{
					"type": "object", "additionalProperties": false, "required": []string{"kind", "items", "limited", "status"},
					"properties": map[string]any{
						"kind": kind, "limited": map[string]any{"type": "boolean"},
						"status": map[string]any{"type": "string", "enum": []string{"ok", "forbidden", "unavailable"}},
						"items": map[string]any{"type": "array", "maxItems": 10, "items": map[string]any{
							"type": "object", "additionalProperties": false, "required": []string{"kind", "id", "title"},
							"properties": map[string]any{"kind": kind, "id": map[string]any{"type": "string", "minLength": 1, "maxLength": 512}, "title": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}},
						}},
					},
				}},
			},
		},
	}
}

func enrichResourceSearchOpenAPI(op, responses map[string]any) {
	op["description"] = "Read-only navigation metadata search. POST body keeps query out of URLs; no query text or result content is logged or audited by this handler. Requires authentication, admin:read and available non-legacy feature access per kind (same sources as existing admin lists). MCP upstream search additionally requires observability:read (the existing MCP list permission), exposes only canonical slug IDs and safe display names, and never fetches discovery data. No admin:write required. Query is trimmed, 2–128 Unicode characters, literal name substring (ASCII case-insensitive; non-ASCII case behavior follows database collation). Five supported configuration kinds: provider, workflow, app, skill and mcp_upstream; no model/upstream calls or business execution. At most ten metadata rows per kind ordered by stored title then ID. Unsafe or oversized IDs/titles are omitted for every role. Definitions, instructions, credentials, URLs and owners are never selected. Provider IDs are opaque references. Limited indicates extra matching storage rows, not an exact count; safe projection may return fewer than ten. Forbidden/unavailable groups carry no items, so partial failure does not hide successful kinds. Each group is a separate read under a shared three-second deadline, not a consistent snapshot or pagination. Unknown fields, duplicate kinds, trailing JSON and URL query strings are rejected; request body is limited to 4096 bytes. Response is no-store."
	op["requestBody"] = requestBody("ResourceSearchRequest")
	responses["200"] = successResponse("ResourceSearchResponse")
	for _, code := range []string{"400", "401", "403", "405", "503"} {
		responses[code] = map[string]any{"description": "Search rejected or unavailable; generic message never echoes query or storage error.", "content": jsonContent(schemaRef("AppError"))}
	}
}
