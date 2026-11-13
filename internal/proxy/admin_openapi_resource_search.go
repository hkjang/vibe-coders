package proxy

func resourceSearchOpenAPISchemas() map[string]any {
	kind := map[string]any{"type": "string", "enum": []string{"provider", "workflow", "app", "skill", "mcp_upstream", "policy", "team", "account", "mcp_tool", "prompt_asset", "prompt_experiment", "setting"}}
	return map[string]any{
		"ResourceSearchRequest": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"query", "kinds"},
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "minLength": 2, "maxLength": 128},
				"kinds": map[string]any{"type": "array", "items": kind, "minItems": 1, "maxItems": 12, "uniqueItems": true},
			},
		},
		"ResourceSearchResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"groups", "request_id"},
			"properties": map[string]any{
				"request_id": map[string]any{"type": "string"},
				"groups": map[string]any{"type": "array", "maxItems": 12, "items": map[string]any{
					"type": "object", "additionalProperties": false, "required": []string{"kind", "items", "limited", "status"},
					"properties": map[string]any{
						"kind": kind, "limited": map[string]any{"type": "boolean"},
						"status": map[string]any{"type": "string", "enum": []string{"ok", "forbidden", "unavailable"}},
						"items": map[string]any{"type": "array", "maxItems": 10, "items": map[string]any{
							"type": "object", "additionalProperties": false, "required": []string{"kind", "id", "title"},
							"properties": map[string]any{"server_label": map[string]any{"type": "string", "minLength": 1, "maxLength": 512, "description": "Present for mcp_tool only; pair with id to identify the observed tool."}, "kind": kind, "id": map[string]any{"type": "string", "minLength": 1, "maxLength": 512}, "title": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}},
						}},
					},
				}},
			},
		},
	}
}

func enrichResourceSearchOpenAPI(op, responses map[string]any) {
	op["description"] = "Read-only navigation metadata search. POST body keeps query out of URLs; no query text or result content is logged or audited by this handler. Requires authentication and available non-legacy feature access per kind. Policy search requires security:read, matching GET /admin/policies; all other kinds require admin:read. MCP server and tool search additionally require observability:read and never fetch discovery data. MCP server search exposes canonical upstream slug IDs and safe display names; observed tool search uses the exact catalog server-label/tool-name pair. A security-only reader must request the policy kind; other groups remain forbidden. No admin:write required. " +
		"Team search requires access.users and applies the same exact authenticated team_admin TeamID scope as GET /admin/teams?view=registered, including an empty team scope. It searches registered team names, not usage groups, IDs or members. Account search also requires access.users and matches GET /admin/users?view=accounts primary-team scope, including unassigned accounts for an empty authenticated team. It selects and searches stored login names only, never email, roles, credentials, membership lists or usage identities. Query is trimmed, 2–128 Unicode characters, literal name substring; SQLite uses the embedded Unicode lowercase function and PostgreSQL uses LOWER for both stored names and query. Observed MCP tool search selects only server_label and tool_name from the existing MCP catalog with is_mcp=1, matches tool names only, and orders by tool name then server label. It returns the exact server_label and tool-name id pair, excludes empty servers and names longer than 256 characters/1024 bytes, and never performs discovery or invokes tools. Prompt asset and experiment search require admin:read and their respective prompts.library/prompts.lab feature, matching the existing admin lists. They select stored asset names or experiment titles and IDs only, never prompt bodies, descriptions, inputs, outputs, metrics, owners or team fields. Setting search requires admin:read and system.settings. It searches only static registered keys, categories and Korean descriptions, ordered by key; no effective, stored or environment values are searched or returned. Twelve supported navigation kinds: provider, workflow, app, skill, mcp_upstream, policy, team, account, mcp_tool, prompt_asset, prompt_experiment and setting; no model/upstream calls or business execution. " +
		"At most ten metadata rows per kind ordered by stored title then ID. IDs are bounded to 512 Unicode characters/2048 UTF-8 bytes and titles to 256 characters/1024 bytes before selection. Unsafe or oversized IDs/titles are omitted for every role without truncating IDs; full team metadata remains available in the registered-team screen. Definitions, policy conditions/actions, instructions, credentials, URLs, members and owners are never selected. Provider IDs are opaque references. Limited indicates extra matching storage rows, not an exact count; safe projection may return fewer than ten. Forbidden/unavailable groups carry no items, so partial failure does not hide successful kinds. Each group is a separate read under a shared three-second deadline, not a consistent snapshot or pagination. Unknown fields, duplicate kinds, trailing JSON and URL query strings are rejected; request body is limited to 4096 bytes. Response is no-store."
	op["requestBody"] = requestBody("ResourceSearchRequest")
	responses["200"] = successResponse("ResourceSearchResponse")
	for _, code := range []string{"400", "401", "403", "405", "503"} {
		responses[code] = map[string]any{"description": "Search rejected or unavailable; generic message never echoes query or storage error.", "content": jsonContent(schemaRef("AppError"))}
	}
}
