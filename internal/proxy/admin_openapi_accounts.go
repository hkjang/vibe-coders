package proxy

import "sort"

func enrichAccountPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read user API. Omit view to retain the Legacy users/auth_users/team_names response. view=usage returns users/team_names without loading login accounts. view=accounts returns a server-paged login account projection without credentials. Account search, role, status, team, sorting and count all apply inside the caller's existing primary-team scope; a team administrator with an empty team sees only unassigned accounts, matching Legacy. Account-page filters apply only to view=accounts. Responses are no-store."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "accounts", "usage"}}},
		map[string]any{"name": "q", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 200}, "description": "Literal, case-insensitive substring of account ID, email, name, role, primary team ID or team name. Percent and underscore are literal. No control characters."},
		map[string]any{"name": "role", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 256}, "description": "Exact role code, including custom roles."},
		map[string]any{"name": "status", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 256}, "description": "Exact account status."},
		map[string]any{"name": "team_id", "in": "query", "allowEmptyValue": true, "schema": map[string]any{"type": "string", "maxLength": 256}, "description": "Exact primary team ID; explicitly empty means unassigned. Never broadens caller scope."},
		map[string]any{"name": "sort", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Up to three unique comma-separated field:asc or field:desc entries. Fields: id,email,name,role,status,team_id,team_name,created_at. Default created_at:desc. ID ascending breaks remaining ties."},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Response selected by view", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("AdminUsersLegacy"), schemaRef("AdminUserUsage"), schemaRef("AuthAccountPage")}}), "headers": map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}}
	for code, description := range map[string]string{"400": "Invalid view or account-page filter; duplicate known account query parameters are rejected", "401": "Invalid authentication or missing admin read scope", "500": "User query failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func accountPageOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	number := map[string]any{"type": "number"}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for name := range properties {
			required = append(required, name)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "required": required, "properties": properties, "additionalProperties": false}
	}
	account := map[string]any{"id": text, "email": text, "name": text, "role": text, "status": text, "team_id": text, "created_at": map[string]any{"type": "string", "format": "date-time"}}
	legacyAccount := object(account)
	pageAccount := map[string]any{}
	for key, value := range account {
		pageAccount[key] = value
	}
	pageAccount["team_name"] = text
	users := map[string]any{"type": "array", "items": schemaRef("AdminUserUsageRow")}
	teams := map[string]any{"type": "object", "additionalProperties": text}
	return map[string]any{
		"AuthAccount": object(pageAccount), "LegacyAuthAccount": legacyAccount,
		"AuthAccountPage":   object(map[string]any{"accounts": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("AuthAccount")}, "total": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000}}),
		"AdminUserUsageRow": object(map[string]any{"api_key_id": text, "name": text, "owner": text, "team": text, "status": text, "requests": count, "tokens": count, "cost_krw": number, "average_latency_ms": number, "last_seen": text}),
		"AdminUserUsage":    object(map[string]any{"users": users, "team_names": teams}),
		"AdminUsersLegacy":  object(map[string]any{"users": users, "team_names": teams, "auth_users": map[string]any{"type": "array", "items": schemaRef("LegacyAuthAccount")}}),
	}
}
