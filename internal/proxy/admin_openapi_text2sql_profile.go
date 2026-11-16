package proxy

func enrichText2SQLProfileOpenAPI(method string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	op["description"] = "Existing administrator-managed virtual-model mappings. exec_connection_id is a stored connection identifier, never a DSN. Empty/default uses the environment/runtime execution DB; a named source can execute without a default DSN and never falls back to another source when unavailable. Named connection availability is checked at execution, not by saving a profile. Existing shared authorization and raw-content restrictions remain. Profile lookup errors stop execution instead of ignoring the mapping."
	switch method {
	case "get":
		op["parameters"] = []any{
			map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"review"}}},
			map[string]any{"name": "virtual_model", "in": "query", "description": "Required only with view=review; exact virtual model name.", "schema": map[string]any{"type": "string"}},
		}
		op["description"] = op["description"].(string) + " Ordinary GET returns the legacy list. view=review&virtual_model=... returns a no-store review snapshot, capability marker and opaque revision or absent. Existing admin:read and raw-content permission required."
		responses["200"] = map[string]any{"description": "Legacy list or opt-in review snapshot", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("Text2SQLProfileList"), schemaRef("Text2SQLProfileReview")}})}
	case "put":
		op["description"] = op["description"].(string) + " Mandatory reviewed complete upsert: all nine non-null unique fields required, no unknown fields/query, 16 KiB UTF-8 body bound, 500-character trimmed reason, 512-byte identifier/model/schema fields. Requires admin:write plus admin:read and raw-content permission. Expected revision is verified in the same short SQL transaction as the profile update and audit insertion. Competing legacy/current writers are serialized. Conflicts return 409; no-op returns 400. Metadata deadline is 5 seconds. This method deliberately returns 405 on old servers; never fall back to POST. Enabled=false stops applying this profile and uses server defaults, not a global SQL execution stop. Connection/schema revisions are not covered; no external connection test or model execution occurs. On uncertain failure, re-read before trying again."
		op["requestBody"] = map[string]any{"required": true, "content": jsonContent(schemaRef("Text2SQLProfileReviewedInput"))}
		responses["200"] = successResponse("Text2SQLProfileSaved")
		responses["409"] = errorResponse("text2sql_profile_conflict: reviewed profile changed; no write")
		responses["503"] = errorResponse("text2sql_profile_review_unavailable: re-read current state before retrying")
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
	row["revision"] = map[string]any{"type": "string", "pattern": "^[0-9a-f]{64}$", "description": "Opaque change token, returned by persisted list/review/PUT reads; absent from legacy POST input echo."}
	reviewed := map[string]any{}
	for _, name := range fields {
		reviewed[name] = map[string]any{"type": "string", "maxLength": 512}
	}
	reviewed["mode"] = map[string]any{"type": "string", "enum": []string{"preview", "execute"}}
	reviewed["enabled"] = map[string]any{"type": "boolean"}
	reviewed["expected_revision"] = map[string]any{"type": "string", "pattern": "^(absent|[0-9a-f]{64})$"}
	reviewed["reason"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 500}
	return map[string]any{
		"Text2SQLProfileReviewedInput": map[string]any{"type": "object", "additionalProperties": false, "required": append(append([]string{}, fields...), "enabled", "expected_revision", "reason"), "properties": reviewed},
		"Text2SQLProfileReview": map[string]any{"type": "object", "required": []string{"review_supported", "profile", "revision"}, "properties": map[string]any{
			"review_supported": map[string]any{"type": "boolean", "enum": []bool{true}},
			"profile":          map[string]any{"nullable": true, "allOf": []any{schemaRef("Text2SQLProfile")}},
			"revision":         map[string]any{"type": "string", "pattern": "^(absent|[0-9a-f]{64})$"},
		}},
		"Text2SQLProfileInput": map[string]any{"type": "object", "required": []string{"virtual_model"}, "properties": input},
		"Text2SQLProfile":      map[string]any{"type": "object", "required": append(fields, "enabled", "updated_at"), "properties": row},
		"Text2SQLProfileSaved": map[string]any{"type": "object", "required": []string{"profile"}, "properties": map[string]any{"profile": schemaRef("Text2SQLProfile")}},
		"Text2SQLProfileList":  map[string]any{"type": "object", "required": []string{"profiles"}, "properties": map[string]any{"profiles": map[string]any{"type": "array", "items": schemaRef("Text2SQLProfile")}}},
	}
}
