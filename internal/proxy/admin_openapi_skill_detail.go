package proxy

import "sort"

func enrichSkillDetailOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read skill catalog. Without name and with an omitted or empty view, the status-filtered full list is unchanged. view=detail requires exactly view and name, returns one exact complete stored skill or null, and is no-store. Names preserve whitespace, slash and reserved characters. Allowed teams/models/tools are execution policy, not catalog visibility; existing authorized instructions and metadata remain available. No evaluation, scan, promotion or execution is performed."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"", "detail"}}},
		map[string]any{"name": "name", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "description": "Required for view=detail. Exact nonempty valid UTF-8 name, at most 4096 bytes, without control characters. No trimming or path normalization. Detail rejects all other query fields."},
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
	return map[string]any{
		"SkillDefinition":  map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties},
		"SkillCatalogList": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"skills"}, "properties": map[string]any{"skills": map[string]any{"type": "array", "items": schemaRef("SkillDefinition"), "nullable": true}}},
		"SkillExactDetail": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"skill"}, "properties": map[string]any{"skill": map[string]any{"nullable": true, "allOf": []any{schemaRef("SkillDefinition")}}}},
	}
}
