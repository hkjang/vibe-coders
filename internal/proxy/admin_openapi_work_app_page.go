package proxy

import "sort"

func enrichWorkAppPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing administrator work app list. Omit view (or use an empty view) for the unchanged full Legacy list. view=page returns bounded metadata without component definitions, filtered count and global total/active/archived/unscoped counts from one statement snapshot. view=detail returns one exact full definition or null. End-user team/role grants do not restrict administrator list visibility. New views are no-store; writes and their authorization are unchanged."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "page", "detail"}}},
		map[string]any{"name": "id", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "description": "Detail only. Exact nonempty UTF-8 identifier, at most 4096 bytes, no control characters. Whitespace and reserved characters are preserved. Cannot be combined with page filters."},
		map[string]any{"name": "q", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 200}, "description": "Page-only literal case-insensitive substring of ID, title, description, owner, allowed teams or roles. Percent and underscore are literal. No control characters; at most 200 Unicode characters and 800 bytes."},
		map[string]any{"name": "status", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "all", "active", "archived"}}},
		map[string]any{"name": "sort", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Page-only, at most three unique comma-separated field:asc or field:desc entries. Fields: id,title,owner,status,created_at,updated_at. Default title:asc. ID ascending breaks ties; timestamps retain nanosecond precision."},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Response selected by view; new views use Cache-Control: no-store", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("WorkAppLegacyList"), schemaRef("WorkAppPage"), schemaRef("WorkAppDetail")}})}
	for code, description := range map[string]string{"400": "Invalid view, filter, identifier or duplicate known parameter", "401": "Invalid authentication or missing administrator read scope", "500": "Work app query failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func workAppPageOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for key := range properties {
			required = append(required, key)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "required": required, "properties": properties, "additionalProperties": false}
	}
	metadata := map[string]any{"id": text, "title": text, "description": text, "icon": text, "allowed_teams": text, "allowed_roles": text, "status": text, "owner": text, "created_at": text, "updated_at": text}
	definition := map[string]any{}
	for key, value := range metadata {
		definition[key] = value
	}
	metadata["component_count"] = count
	definition["components"] = map[string]any{"type": "array", "items": schemaRef("WorkAppComponent")}
	run := object(map[string]any{
		"id": text, "app_id": text, "user_id": text, "team": text, "status": text, "input_hash": text, "output_summary": text, "error_class": text, "trace_id": text, "created_at": text,
		"latency_ms": map[string]any{"type": "integer"}, "cost_krw": map[string]any{"type": "number"},
	})
	run["properties"].(map[string]any)["app_title"] = text
	return map[string]any{
		"WorkAppRunMetadata": run,
		"WorkAppRunList":     object(map[string]any{"runs": map[string]any{"type": "array", "maxItems": 200, "items": schemaRef("WorkAppRunMetadata")}}),
		"WorkAppComponent":   object(map[string]any{"kind": text, "ref": text, "label": text}),
		"WorkAppDefinition":  object(definition),
		"WorkAppMetadata":    object(metadata),
		"WorkAppLegacyList":  object(map[string]any{"apps": map[string]any{"type": "array", "items": schemaRef("WorkAppDefinition")}}),
		"WorkAppDetail":      object(map[string]any{"app": map[string]any{"nullable": true, "allOf": []any{schemaRef("WorkAppDefinition")}}}),
		"WorkAppPage": object(map[string]any{
			"apps":  map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("WorkAppMetadata")},
			"total": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000},
			"summary": object(map[string]any{"total": count, "active": count, "archived": count, "unscoped": count}),
		}),
	}
}
