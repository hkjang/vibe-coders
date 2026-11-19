package proxy

import "sort"

func enrichSkillDetailOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read skill catalog. Without name or skill_ref and with an omitted or empty view, the status-filtered full list is unchanged. view=detail requires exactly view and one of name or skill_ref, returns one exact complete stored skill or null, and is no-store. Names preserve whitespace, slash and reserved characters. skill_ref is an opaque HMAC identity stable across servers sharing GATEWAY_SECRET, intentionally invalidated by secret rotation; it does not grant access. Invalid or mixed references fail closed and missing references return null. Reference reads cover long and protected names without putting them in URLs. Allowed teams/models/tools are execution policy, not catalog visibility; existing authorized instructions and metadata remain available. No evaluation, scan, promotion or execution is performed."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "detail"}}},
		map[string]any{"name": "name", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "description": "Alternative to skill_ref for view=detail. Exact nonempty valid UTF-8 name, at most 4096 bytes, without control characters. No trimming or path normalization. Detail rejects all other query fields except view."},
		map[string]any{"name": "skill_ref", "in": "query", "schema": skillReferenceOpenAPISchema(), "description": "Alternative to name. Exactly one canonical reference; no literal-name fallback."},
		map[string]any{"name": "status", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Existing list-only status filter. Omit for all statuses."},
	}
	responses["200"] = map[string]any{"description": "Existing list or exact detail selected by view", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("SkillCatalogList"), schemaRef("SkillExactDetail")}})}
	for code, description := range map[string]string{"400": "Invalid exact detail query", "401": "Invalid authentication or missing admin read scope", "500": "Skill read failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}
func skillDetailOpenAPISchemas() map[string]any {
	properties := map[string]any{}
	for _, key := range []string{"name", "description", "version", "owner", "status", "risk_level", "allowed_models", "allowed_tools", "allowed_teams", "instructions", "metadata", "created_at", "updated_at", "updated_by"} {
		properties[key] = map[string]any{"type": "string"}
	}
	properties["daily_limit"] = map[string]any{"type": "integer"}
	required := make([]string, 0, len(properties))
	for key := range properties {
		required = append(required, key)
	}
	sort.Strings(required)
	properties["skill_ref"] = skillReferenceOpenAPISchema()
	return map[string]any{
		"SkillDefinition":  map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties},
		"SkillCatalogList": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"skills"}, "properties": map[string]any{"skills": map[string]any{"type": "array", "items": schemaRef("SkillDefinition"), "nullable": true}}},
		"SkillExactDetail": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"skill"}, "properties": map[string]any{"skill": map[string]any{"nullable": true, "allOf": []any{schemaRef("SkillDefinition")}}}},
	}
}

func skillReferenceOpenAPISchema() map[string]any {
	return map[string]any{"type": "string", "pattern": "^skl_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$", "minLength": 47, "maxLength": 47, "description": "Canonical unpadded base64url HMAC reference; final pad bits must be zero. Identity only, never authorization. Changes when GATEWAY_SECRET rotates."}
}
func enrichSkillReferenceDeleteOpenAPI(op, responses map[string]any) {
	op["description"] = "Deletes exactly the existing skill selected by skill_ref under unchanged admin write authorization. Requires exactly one skill_ref query and no other query keys. Missing/stale references return 404, invalid/mixed selectors 400, with no name fallback or path normalization."
	op["parameters"] = []any{map[string]any{"name": "skill_ref", "in": "query", "required": true, "schema": skillReferenceOpenAPISchema()}}
	responses["200"] = map[string]any{"description": "Selected skill deleted", "content": jsonContent(map[string]any{"type": "object", "required": []string{"skill_ref", "deleted"}, "properties": map[string]any{"skill_ref": skillReferenceOpenAPISchema(), "deleted": map[string]any{"type": "boolean"}}})}
	for _, code := range []string{"400", "401", "404", "500"} {
		responses[code] = map[string]any{"description": "Invalid selector, authorization, missing target or storage failure", "content": jsonContent(schemaRef("AppError"))}
	}
}

func enrichSkillReferenceOperation(operation string, op, responses map[string]any) {
	text := func() map[string]any { return map[string]any{"type": "string"} }
	properties := map[string]any{"name": text(), "skill_ref": skillReferenceOpenAPISchema()}
	identity := []any{
		map[string]any{"required": []string{"name"}, "properties": map[string]any{"name": map[string]any{"type": "string", "minLength": 1}}},
		map[string]any{"required": []string{"skill_ref"}},
	}
	description := "Name-only callers retain legacy Go TrimSpace behavior. Optional skill_ref selects an existing exact identity without trimming; name may be omitted or echo that exact identity. Invalid/mismatched refs 400; missing/stale refs 404; no fallback to names. Existing authorization, mutation and security gates remain unchanged."
	switch operation {
	case "post /admin/skills":
		for _, key := range []string{"description", "version", "owner", "status", "risk_level", "allowed_models", "allowed_tools", "allowed_teams", "instructions"} {
			properties[key] = text()
		}
		properties["daily_limit"] = map[string]any{"type": "integer"}
		properties["metadata"] = map[string]any{"description": "Any valid JSON. When skill_ref is used, omission preserves stored metadata; explicit null resets to the existing empty object default."}
		description += " Creates/upserts legacy names; a reference updates only its existing skill. Omitted metadata is preserved on a reference update."
		delete(responses, "200")
		responses["201"] = map[string]any{"description": "Saved skill with opaque reference", "content": jsonContent(schemaRef("SkillExactDetail"))}
	case "post /admin/skills/promote":
		for _, key := range []string{"to_status", "version", "note"} {
			properties[key] = text()
		}
		responses["200"] = map[string]any{"description": "Promoted skill with opaque reference", "content": jsonContent(schemaRef("SkillExactDetail"))}
		responses["422"] = map[string]any{"description": "Existing lifecycle, production policy, security scan or fitness gate rejected the transition", "content": jsonContent(schemaRef("AppError"))}
	case "post /admin/skills/evaluate":
		properties["model"], properties["team"] = text(), text()
		properties["tools"] = map[string]any{"type": "array", "items": text()}
	default:
		nameKey := "name"
		if operation == "get /admin/skills/runs" || operation == "get /admin/skills/promotions" {
			nameKey = "skill"
		}
		op["parameters"] = []any{
			map[string]any{"name": nameKey, "in": "query", "schema": text(), "description": "Legacy Go-trimmed name selector. Mutually exclusive with skill_ref."},
			map[string]any{"name": "skill_ref", "in": "query", "schema": skillReferenceOpenAPISchema(), "description": "Exact existing identity; no name fallback."},
		}
		if nameKey == "skill" {
			op["parameters"] = append(op["parameters"].([]any), map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer"}, "description": "Existing recent-row limit."})
		}
		op["description"] = "Existing read behavior when using the legacy name selector. Alternatively skill_ref selects one existing exact skill without putting its name in the URL. It cannot be mixed with the name selector; malformed refs 400, stale/missing refs 404. References do not expand visibility."
	}
	if operation == "post /admin/skills" || operation == "post /admin/skills/promote" || operation == "post /admin/skills/evaluate" {
		body := map[string]any{"type": "object", "anyOf": identity, "properties": properties}
		if operation == "post /admin/skills/promote" {
			body["required"] = []string{"to_status"}
		}
		op["requestBody"] = map[string]any{"required": true, "content": jsonContent(body)}
		op["description"] = description
	}
	for _, code := range []string{"400", "401", "404", "500"} {
		responses[code] = map[string]any{"description": "Invalid selector, authorization, missing target or storage failure", "content": jsonContent(schemaRef("AppError"))}
	}
}
