package proxy

import "sort"

func enrichTeamPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read team API. Omit view to retain teams/auth_teams. view=usage returns existing usage without loading the registered-team catalog. view=registered returns a server-paged registered-team catalog inside the caller's existing team scope. Search and count use that same scope. New search-input bounds do not restrict existing authenticated team identifiers or stored metadata. Responses are no-store."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "registered", "usage"}}},
		map[string]any{"name": "q", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 200}, "description": "Literal case-insensitive substring of team ID or name, without control characters. Percent and underscore are literal. Applies only to view=registered."},
		map[string]any{"name": "id", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "description": "Exact registered-team ID, at most 4096 UTF-8 bytes without control characters. Combined with the authenticated team scope and other filters; never broadens permissions. Applies only to view=registered. Missing or out-of-scope IDs return an empty authorized page."},
		map[string]any{"name": "sort", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Up to three unique comma-separated field:asc or field:desc entries. Fields: id,name,created_at,updated_at. Default name:asc. ID ascending breaks remaining ties. Applies only to view=registered."},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Response selected by view", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("AdminTeamsLegacy"), schemaRef("AdminTeamUsage"), schemaRef("AuthTeamPage")}}), "headers": map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}}
	for code, description := range map[string]string{"400": "Invalid view or registered-team filter", "401": "Invalid authentication or missing admin read scope", "500": "Team query failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func teamPageOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	number := map[string]any{"type": "number"}
	date := map[string]any{"type": "string", "format": "date-time"}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for name := range properties {
			required = append(required, name)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "required": required, "properties": properties, "additionalProperties": false}
	}
	usage := map[string]any{"type": "array", "items": schemaRef("AdminTeamUsageRow")}
	registered := map[string]any{"type": "array", "items": schemaRef("RegisteredTeam")}
	return map[string]any{
		"RegisteredTeam":    object(map[string]any{"id": text, "name": text, "created_at": date, "updated_at": date}),
		"AuthTeamPage":      object(map[string]any{"auth_teams": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("RegisteredTeam")}, "total": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000}}),
		"AdminTeamUsageRow": object(map[string]any{"team": text, "keys": count, "requests": count, "tokens": count, "cost_krw": number, "average_latency_ms": number, "last_seen": text}),
		"AdminTeamUsage":    object(map[string]any{"teams": usage}),
		"AdminTeamsLegacy":  object(map[string]any{"teams": usage, "auth_teams": registered}),
	}
}
