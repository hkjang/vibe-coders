package proxy

import "slices"

func enrichContextMetadataOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing global admin:read registry. Without view, legacy GET returns contexts with content unchanged. Opt-in view=metadata returns a bounded, read-only page ordered by stored key ascending. Content and mutation IDs are never selected. Unsafe names/keys are replaced with [숨김], including for privileged callers. Count and page share a read snapshot; separate pages may change as the registry changes. use_count counts context expansion touches, not unique requests or successful model calls; token_estimate is a stored estimate. Invalid historic counts/timestamps are null. The metadata view rejects extra/duplicate/malformed parameters and is no-store."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"metadata"}}},
		map[string]any{"name": "state", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"all", "enabled", "disabled"}, "default": "all"}},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Legacy content list or explicit metadata page", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("ContextRegistryLegacyList"), schemaRef("ContextRegistryMetadataPage")}})}
	for _, code := range []string{"400", "401", "403", "405", "500"} {
		responses[code] = map[string]any{"description": "Query or authorization failure; metadata errors omit storage details", "content": jsonContent(schemaRef("AppError"))}
	}
}

func contextMetadataOpenAPISchemas() map[string]any {
	object := func(fields map[string]any) map[string]any {
		required := make([]string, 0, len(fields))
		for name := range fields {
			required = append(required, name)
		}
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	nullCount := map[string]any{"type": "integer", "minimum": 0, "nullable": true}
	stamp := map[string]any{"type": "string", "format": "date-time"}
	nullStamp := map[string]any{"type": "string", "format": "date-time", "nullable": true}
	boolean := map[string]any{"type": "boolean"}
	legacy := object(map[string]any{"id": text, "key": text, "name": text, "content": text, "enabled": boolean, "token_estimate": map[string]any{"type": "integer"}, "use_count": map[string]any{"type": "integer"}, "last_used_at": stamp, "created_at": stamp, "updated_at": stamp})
	item := object(map[string]any{"key": text, "name": text, "enabled": boolean, "token_estimate": nullCount, "use_count": nullCount, "last_used_at": nullStamp, "updated_at": nullStamp})
	return map[string]any{
		"ContextRegistryLegacyList":   object(map[string]any{"contexts": map[string]any{"type": "array", "items": legacy}}),
		"ContextRegistryMetadataItem": item,
		"ContextRegistryMetadataPage": object(map[string]any{
			"items": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("ContextRegistryMetadataItem")},
			"total": count, "offset": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
			"state": map[string]any{"type": "string", "enum": []string{"all", "enabled", "disabled"}}, "generated_at": stamp,
		}),
	}
}
