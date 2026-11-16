package proxy

import "slices"

func enrichPromptProductMetadataOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing global admin:read product registry. Default GET keeps the legacy list. view=metadata returns a bounded no-store projection without bodies, descriptions, authors, fingerprints or mutation IDs. Sorted by stored created_at descending then product ID ascending; count and page share one read snapshot. source_requests and source_distinct_keys are saved registration snapshots; keys are not people. Without a source fingerprint these saved default counts are returned as null. use_count counts current template expansion touches, not model success or billing. Missing templates have null use_count. Invalid counts/timestamps are null. Unsafe names/categories are hidden. Metadata requests reject duplicate, extra and malformed parameters."
	op["parameters"] = []any{
		map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"metadata"}}},
		map[string]any{"name": "state", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"all", "enabled", "disabled", "missing"}, "default": "all"}},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Legacy product list or explicit metadata page", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("PromptProductLegacyList"), schemaRef("PromptProductMetadataPage")}})}
	for _, code := range []string{"400", "401", "403", "405", "500"} {
		responses[code] = map[string]any{"description": "Query, permission or storage failure; metadata errors omit storage details", "content": jsonContent(schemaRef("AppError"))}
	}
}

func promptProductMetadataOpenAPISchemas() map[string]any {
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
	integer := map[string]any{"type": "integer"}
	nullCount := map[string]any{"type": "integer", "minimum": 0, "maximum": 9007199254740991, "nullable": true}
	stamp := map[string]any{"type": "string", "format": "date-time"}
	nullStamp := map[string]any{"type": "string", "format": "date-time", "nullable": true}
	legacy := object(map[string]any{"id": text, "name": text, "description": text, "category": text, "source_fingerprint": text, "template_id": text, "request_count": integer, "distinct_users": integer, "created_by": text, "created_at": text, "updated_at": text, "template_use_count": integer, "template_last_used": text})
	item := object(map[string]any{
		"name": text, "category": text, "template_state": map[string]any{"type": "string", "enum": []string{"enabled", "disabled", "missing"}},
		"source_requests": nullCount, "source_distinct_keys": nullCount, "use_count": nullCount, "last_used_at": nullStamp, "created_at": nullStamp,
	})
	return map[string]any{
		"PromptProductLegacyList":   object(map[string]any{"products": map[string]any{"type": "array", "items": legacy}}),
		"PromptProductMetadataItem": item,
		"PromptProductMetadataPage": object(map[string]any{
			"items": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("PromptProductMetadataItem")},
			"total": count, "offset": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
			"state": map[string]any{"type": "string", "enum": []string{"all", "enabled", "disabled", "missing"}}, "generated_at": stamp,
		}),
	}
}
