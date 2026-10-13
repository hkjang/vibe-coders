package proxy

func enrichAdminKeyEditOpenAPI(op, responses map[string]any) {
	op["requestBody"] = map[string]any{"required": true, "content": jsonContent(schemaRef("AdminKeyUpdateRequest"))}
	op["description"] = "Partially updates key metadata or explicit scopes. Omitted or null fields keep their existing values; scopes=[] clears grants. Optional review requires both reason and expected_revision. Reviewed requests reject stale snapshots, duplicate/unknown fields, no-op updates and accepted bodies over 8192 bytes. Legacy field semantics are preserved without review. Current role/scope/team authority is enforced; the authorized row snapshot and edit/audit commit atomically. Catalog edit_review_supported identifies support on the responding server; upgrade all pods before reviewed writes. This is snapshot comparison, not an ever-increasing revision counter."
	for code, description := range map[string]string{"400": "Invalid edit or review", "401": "Authentication required", "403": "Insufficient role, scope or team authority", "404": "Key not found", "409": "Key changed since review or authorization", "500": "Update not confirmed; inspect current key and audit", "503": "Review authority unavailable"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["200"] = successResponse("AdminKeyUpdateResponse")
}

func adminKeyEditOpenAPISchemas() map[string]any {
	fields := map[string]any{}
	for _, name := range []string{"name", "owner", "team", "role"} {
		fields[name] = map[string]any{"type": "string", "nullable": true}
	}
	fields["status"] = map[string]any{"type": "string", "nullable": true, "enum": []any{"active", "disabled", nil}}
	fields["scopes"] = map[string]any{"type": "array", "nullable": true, "items": map[string]any{"type": "string"}}
	fields["review"] = schemaRef("AdminKeyEditReview")
	response := map[string]any{}
	for _, name := range []string{"id", "name", "owner", "team", "role", "status"} {
		response[name] = map[string]any{"type": "string"}
	}
	response["scopes"] = fields["scopes"]
	return map[string]any{
		"AdminKeyEditReview": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"reason", "expected_revision"}, "properties": map[string]any{
			"reason":            map[string]any{"type": "string", "minLength": 1, "maxLength": 1024, "description": "Trimmed nonblank audit reason."},
			"expected_revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "Exact catalog snapshot revision."},
		}},
		// The legacy decoder ignores extensions, but any review marker opts in
		// to the strict variant. Keep review's property type in both branches
		// for generators that cannot express the JSON Schema `not` constraint.
		"AdminKeyLegacyUpdateRequest": map[string]any{"type": "object", "nullable": true, "additionalProperties": true, "properties": fields,
			"not": map[string]any{"type": "object", "required": []string{"review"}}},
		"AdminKeyReviewedUpdateRequest": map[string]any{"type": "object", "additionalProperties": false, "properties": fields, "required": []string{"review"}},
		"AdminKeyUpdateRequest":         map[string]any{"oneOf": []any{schemaRef("AdminKeyLegacyUpdateRequest"), schemaRef("AdminKeyReviewedUpdateRequest")}},
		"AdminKeyUpdateResponse":        map[string]any{"type": "object", "required": []string{"id", "name", "owner", "team", "role", "scopes", "status"}, "properties": response},
	}
}
