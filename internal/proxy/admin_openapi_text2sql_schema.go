package proxy

func enrichText2SQLSchemaDetailOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read Text2SQL overview. Without view/name, preserves the complete legacy overview and its projection. view=schema&name=... returns one exact stored schema, including disabled entries, using the same global-or-authenticated-team visibility and raw-prompt permission as the overview. Team aliases resolve through the existing checked team-scope helper; lookup failure never broadens access. This mode performs no query execution, connection test, model call or mutation. It does not fall back to a default schema. Names are exact, nonempty trimmed UTF-8, at most 512 Unicode characters/2048 bytes, with no control/format characters. Detail mode rejects duplicate, malformed or extra query parameters. Missing and out-of-scope schemas both return generic 404; no supplied name or storage error is echoed. Detail responses are no-store. raw_content_available is the existing canViewRawPrompts result; false preserves the overview projection, omitting schema text and allowed tables."
	op["parameters"] = []any{
		map[string]any{"name": "window", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Existing overview period, only without detail mode."},
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"schema"}}},
		map[string]any{"name": "name", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 512}, "description": "Required exact name when view=schema; never a pattern or default selector."},
	}
	responses["200"] = map[string]any{"description": "Legacy overview or exact detail selected by view", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("Text2SQLLegacyOverview"), schemaRef("Text2SQLSchemaDetailResponse")}})}
	for _, code := range []string{"400", "401", "403", "404", "500"} {
		responses[code] = map[string]any{"description": "Text2SQL query rejected or unavailable; generic error never echoes the schema context.", "content": jsonContent(schemaRef("AppError"))}
	}
}

func text2SQLSchemaDetailOpenAPISchemas() map[string]any {
	fields := map[string]any{}
	for _, field := range []string{"team", "name", "dialect", "schema_text", "collected_at", "source_fingerprint", "updated_at"} {
		fields[field] = map[string]any{"type": "string"}
	}
	fields["allowed_tables"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	fields["is_default"] = map[string]any{"type": "boolean"}
	fields["enabled"] = map[string]any{"type": "boolean"}
	fields["version"] = map[string]any{"type": "integer"}
	return map[string]any{
		"Text2SQLSchemaView":           map[string]any{"type": "object", "additionalProperties": false, "required": []string{"team", "name", "dialect", "schema_text", "allowed_tables", "is_default", "enabled", "version", "collected_at", "source_fingerprint", "updated_at"}, "properties": fields},
		"Text2SQLSchemaDetailResponse": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"schema", "raw_content_available"}, "properties": map[string]any{"schema": schemaRef("Text2SQLSchemaView"), "raw_content_available": map[string]any{"type": "boolean"}}},
		"Text2SQLLegacyOverview":       map[string]any{"type": "object", "additionalProperties": true, "required": []string{"schemas"}, "properties": map[string]any{"schemas": map[string]any{"type": "array", "items": schemaRef("Text2SQLSchemaView")}}, "description": "Preserved legacy overview; other existing statistics, logs and registry fields are unchanged."},
	}
}
