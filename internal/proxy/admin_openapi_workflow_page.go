package proxy

import "sort"

func enrichWorkflowPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read workflow API. Omit view (or use an empty view) to retain the full Legacy definition list. view=page returns bounded metadata without step definitions, filtered count, and global total/enabled counts from one database statement snapshot. view=detail returns one exact full definition or null. Allowed teams restrict execution, not administrator visibility. New views are no-store; writes and their authorization are unchanged."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "page", "detail"}}},
		map[string]any{"name": "id", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "description": "Required only for view=detail. Exact nonempty UTF-8 identifier, at most 4096 bytes, without control characters. Whitespace and reserved characters are preserved. Cannot be combined with page filters."},
		map[string]any{"name": "q", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 200}, "description": "Page-only literal case-insensitive substring of ID, name, description or execution team names. Percent and underscore are literal. No control characters; at most 200 Unicode characters and 800 bytes."},
		map[string]any{"name": "status", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "all", "enabled", "disabled"}}},
		map[string]any{"name": "sort", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Page-only, up to three unique comma-separated field:asc or field:desc entries. Fields: id,name,allowed_teams,enabled,created_at,updated_at. Default created_at:desc. ID ascending breaks ties; timestamps retain nanosecond precision."},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Response selected by view; new views use Cache-Control: no-store", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("WorkflowLegacyList"), schemaRef("WorkflowPage"), schemaRef("WorkflowDetail")}})}
	for code, description := range map[string]string{"400": "Invalid view/filter/identifier or duplicate known view parameter", "401": "Invalid authentication or missing admin read scope", "500": "Workflow query failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func workflowPageOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for name := range properties {
			required = append(required, name)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "required": required, "properties": properties, "additionalProperties": false}
	}
	metadata := map[string]any{"id": text, "name": text, "description": text, "allowed_teams": text, "enabled": map[string]any{"type": "boolean"}, "created_by": text, "created_at": text, "updated_at": text}
	definition := map[string]any{}
	for key, value := range metadata {
		definition[key] = value
	}
	metadata["step_count"] = count
	definition["steps"] = map[string]any{"type": "array", "nullable": true, "items": schemaRef("WorkflowDefinitionStep")}
	step := map[string]any{"type": "object", "required": []string{"name", "type"}, "additionalProperties": false, "properties": map[string]any{
		"name": text, "type": text, "ref": text, "note": text,
		"timeout_ms": map[string]any{"type": "integer"}, "max_tokens": map[string]any{"type": "integer"}, "max_cost_krw": map[string]any{"type": "number"},
		"allowed_tools": map[string]any{"type": "array", "items": text}, "allowed_tables": map[string]any{"type": "array", "items": text},
	}}
	run := object(map[string]any{
		"id": text, "workflow_id": text, "user_id": text, "team": text, "status": text, "error_class": text, "trace_id": text, "created_at": text,
		"steps_total": map[string]any{"type": "integer"}, "steps_ok": map[string]any{"type": "integer"}, "latency_ms": map[string]any{"type": "integer"}, "cost_krw": map[string]any{"type": "number"},
	})
	run["properties"].(map[string]any)["workflow_name"] = text // omitted when the definition is gone
	return map[string]any{
		"WorkflowRunMetadata": run,
		"WorkflowRunList":     object(map[string]any{"runs": map[string]any{"type": "array", "maxItems": 200, "items": schemaRef("WorkflowRunMetadata")}}),
		"WorkflowMetadata":    object(metadata), "WorkflowDefinition": object(definition), "WorkflowDefinitionStep": step,
		"WorkflowLegacyList": object(map[string]any{"workflows": map[string]any{"type": "array", "items": schemaRef("WorkflowDefinition")}}),
		"WorkflowDetail":     object(map[string]any{"workflow": map[string]any{"nullable": true, "allOf": []any{schemaRef("WorkflowDefinition")}}}),
		"WorkflowPage": object(map[string]any{
			"workflows": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("WorkflowMetadata")},
			"total":     count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000},
			"summary": object(map[string]any{"total": count, "enabled": count}),
		}),
	}
}
