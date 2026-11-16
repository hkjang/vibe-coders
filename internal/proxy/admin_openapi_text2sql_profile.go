package proxy

func enrichText2SQLProfileOpenAPI(method string, op, responses map[string]any) {
	op["description"] = "Existing administrator-managed virtual-model mappings. exec_connection_id is a stored connection identifier, never a DSN. Empty/default uses the environment/runtime execution DB; a named source can execute without a default DSN and never falls back to another source when unavailable. Named connection availability is checked at execution, not by saving a profile. Existing shared authorization and raw-content restrictions remain. Profile lookup errors stop execution instead of ignoring the mapping."
	switch method {
	case "get":
		responses["200"] = successResponse("Text2SQLProfileList")
	case "post":
		op["description"] = op["description"].(string) + " Upserts the complete profile. virtual_model and mode are trimmed/lowercased; mode accepts empty, preview or execute and defaults to preview in storage. Other text is trimmed. Omitted/null exec_connection_id selects the default; omitted/null enabled defaults true. No merge, revision guard or connection probe is implied. The response returns the normalized input; updated_at is populated by a subsequent list read."
		op["requestBody"] = map[string]any{"required": true, "content": jsonContent(schemaRef("Text2SQLProfileInput"))}
		responses["201"] = successResponse("Text2SQLProfileSaved")
	case "delete":
		op["parameters"] = []any{map[string]any{"name": "virtual_model", "in": "query", "required": true, "schema": map[string]any{"type": "string"}}}
		responses["200"] = map[string]any{"description": "Deleted profile identifier and status"}
	}
	for _, code := range []string{"400", "401", "403", "500"} {
		responses[code] = map[string]any{"description": "Existing validation, authorization or storage failure", "content": jsonContent(schemaRef("AppError"))}
	}
}

func text2SQLProfileOpenAPISchemas() map[string]any {
	input, row := map[string]any{}, map[string]any{}
	fields := []string{"virtual_model", "mode", "upstream_model", "summary_model", "schema_name", "exec_connection_id"}
	for _, name := range fields {
		input[name] = map[string]any{"type": "string", "nullable": name != "virtual_model"}
		row[name] = map[string]any{"type": "string"}
	}
	input["mode"].(map[string]any)["description"] = "Case-insensitive preview or execute; empty/omitted/null defaults to preview in storage."
	input["exec_connection_id"].(map[string]any)["description"] = "Trimmed connection identifier. Empty/default selects runtime/environment DB. No credentials."
	input["enabled"] = map[string]any{"type": "boolean", "nullable": true, "default": true}
	row["enabled"] = map[string]any{"type": "boolean"}
	row["updated_at"] = map[string]any{"type": "string"}
	return map[string]any{
		"Text2SQLProfileInput": map[string]any{"type": "object", "required": []string{"virtual_model"}, "properties": input},
		"Text2SQLProfile":      map[string]any{"type": "object", "required": append(fields, "enabled", "updated_at"), "properties": row},
		"Text2SQLProfileSaved": map[string]any{"type": "object", "required": []string{"profile"}, "properties": map[string]any{"profile": schemaRef("Text2SQLProfile")}},
		"Text2SQLProfileList":  map[string]any{"type": "object", "required": []string{"profiles"}, "properties": map[string]any{"profiles": map[string]any{"type": "array", "items": schemaRef("Text2SQLProfile")}}},
	}
}
