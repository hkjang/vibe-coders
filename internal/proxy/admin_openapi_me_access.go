package proxy

func enrichMeAccessOpenAPI(route, method string, op, responses map[string]any) {
	names := map[string]string{
		"/me/sessions": "MeAccessSessions", "/me/sessions/{id}": "MeAccessSessionRevoked",
		"/me/sessions/revoke-others": "MeAccessSessionsRevoked", "/me/onboarding-pack": "MeAccessOnboarding",
		"/me/connection-doctor": "MeAccessDoctor",
	}
	op["description"] = "Existing personal JWT-session API. Requires an identified JWT subject, not an administrator scope or proxy API key. Responses are no-store. Session and associated refresh-token revocation commit together; success does not imply an atomic client review or cross-tab idempotency."
	if route == "/me/sessions/revoke-others" {
		op["description"] = op["description"].(string) + " Keeps the JWT session ID and revokes this user's other unrevoked records, including expired records. The count can exceed the active-session list. No request body is required."
	}
	if route == "/me/onboarding-pack" {
		op["description"] = "Existing connection metadata and placeholder examples. Accepts an identified JWT or proxy API key. Key allow/deny rules filter the priced model catalog when a key is used. JWT metadata is not a test of a particular issued key. No secret is re-exposed. Responses are no-store."
		op["parameters"] = []any{map[string]any{"name": "client", "in": "query", "required": false, "schema": map[string]any{"type": "string", "default": "mcp"}, "description": "Trimmed and lowercased; supports openai-sdk, cursor, roo, cline, claude, claude-desktop-mcp and mcp. Unknown clients retain generic connection metadata."}}
	}
	if route == "/me/connection-doctor" {
		op["description"] = "Existing explicit read-only connection inspection. A proxy key probes the model-list endpoint and, for MCP clients, initialize/tools-list. JWT mode inspects key metadata and skips endpoint probes. Anonymous callers receive HTTP 200 with failed authentication, not private key metadata. No model completion or configuration write. Responses are no-store; do not automatically repeat the POST."
		op["security"] = []any{}
		op["requestBody"] = map[string]any{"required": false, "content": jsonContent(schemaRef("MeAccessDoctorInput"))}
	}
	responses["200"] = successResponse(names[route])
	responses["200"].(map[string]any)["headers"] = map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}
	errors := map[string]string{"405": "Unsupported method"}
	if route != "/me/connection-doctor" {
		errors["401"] = "Caller not identified"
	}
	if route != "/me/connection-doctor" && route != "/me/onboarding-pack" {
		errors["500"] = "Session operation failed"
	}
	if route == "/me/sessions/{id}" {
		errors["400"] = "Invalid session identifier"
		errors["404"] = "Session not found, already revoked or owned by another user"
	}
	for code, description := range errors {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func meAccessOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	list := func(item map[string]any) map[string]any { return map[string]any{"type": "array", "items": item} }
	object := func(required []string, properties map[string]any) map[string]any {
		out := map[string]any{"type": "object", "properties": properties}
		if len(required) > 0 {
			out["required"] = required
		}
		return out
	}
	revoked := map[string]any{"type": "string", "enum": []string{"revoked"}}
	mcpServer := object([]string{"url", "headers"}, map[string]any{"url": text, "headers": object([]string{"Authorization"}, map[string]any{"Authorization": map[string]any{"type": "string", "enum": []string{"Bearer <YOUR_API_KEY>"}}})})
	return map[string]any{
		"MeAccessSessions": object([]string{"current_session_id", "sessions"}, map[string]any{
			"current_session_id": text,
			"sessions": list(object([]string{"id", "ip", "user_agent", "created_at", "expires_at", "sso_linked", "current"}, map[string]any{
				"id": text, "ip": text, "user_agent": text, "created_at": text, "expires_at": text, "sso_linked": flag, "current": flag,
			})),
		}),
		"MeAccessSessionRevoked":  object([]string{"status", "session_id"}, map[string]any{"status": revoked, "session_id": text}),
		"MeAccessSessionsRevoked": object([]string{"status", "revoked_count"}, map[string]any{"status": revoked, "revoked_count": map[string]any{"type": "integer", "minimum": 0}}),
		"MeAccessDoctorInput":     object([]string{}, map[string]any{"client": map[string]any{"type": "string", "default": "openai-sdk", "description": "Trimmed and lowercased; recognized MCP clients also request MCP probes when a proxy key is present."}}),
		"MeAccessDoctor": object([]string{"client", "overall", "checks", "base_url", "mcp_url"}, map[string]any{
			"client": text, "overall": map[string]any{"type": "string", "enum": []string{"pass", "warn", "fail"}},
			"auth_mode": map[string]any{"type": "string", "enum": []string{"jwt", "proxy_key"}, "description": "Absent for anonymous authentication failure."},
			"note":      text, "base_url": text, "mcp_url": text,
			"checks": list(object([]string{"name", "status", "detail"}, map[string]any{"name": text, "status": map[string]any{"type": "string", "enum": []string{"pass", "warn", "fail", "skip"}}, "detail": text, "fix": text})),
		}),
		"MeAccessOnboarding": object([]string{"client", "base_url", "mcp_url", "available_models", "recommended_models", "scopes", "budget_limit_krw", "mcp_config", "sample_curl", "note", "config_label", "config"}, map[string]any{
			"client": text, "base_url": text, "mcp_url": text, "available_models": list(text), "recommended_models": list(text),
			"scopes": map[string]any{"type": "array", "nullable": true, "items": text}, "budget_limit_krw": map[string]any{"type": "number"},
			"mcp_config":  object([]string{"mcpServers"}, map[string]any{"mcpServers": object([]string{"vibe-gateway"}, map[string]any{"vibe-gateway": mcpServer})}),
			"sample_curl": text, "note": text, "config_label": text, "config": text,
		}),
	}
}
