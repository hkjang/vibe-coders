package proxy

import "sort"

func enrichTraceRelatedRunsOpenAPI(op, responses map[string]any) {
	op["description"] = "Returns a metadata-only, server-paged workflow or app execution list for the exact trace. Existing admin read and team scope are applied before counting/paging; rows and count share one SQL statement snapshot. Ordering is recorded UTC created_at at nanosecond precision then ID descending. Pages are live reads, not a cross-page snapshot. No prompt, output, error class, hash, team/user identity or step definition is returned, including to raw-view administrators. Unsafe identifiers/names and invalid metrics are null. Receipt availability only identifies the authenticated owner; destination permissions and receipt authorization still apply. This read-only projection has no-store and a three-second query deadline."
	op["parameters"] = []any{
		map[string]any{"name": "trace_id", "in": "path", "required": true, "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 1024}},
		map[string]any{"name": "kind", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"workflow", "app"}}, "required": true},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "enum": []int{25, 50, 100}, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
	}
	responses["200"] = map[string]any{"description": "Related execution page; existing trace export is separate and unchanged.", "content": jsonContent(schemaRef("TraceRelatedRunPage"))}
	for status, description := range map[string]string{"400": "Invalid kind, duplicate/unknown parameter, bounds or sensitive trace ID", "401": "Existing administrator read authentication required", "405": "GET required", "500": "Trace query failed; no partial page or count returned"} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}
func traceRelatedRunSchemas() map[string]any {
	object := func(properties map[string]any) map[string]any {
		required := []string{}
		for k := range properties {
			required = append(required, k)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
	}
	text := map[string]any{"type": "string", "nullable": true, "maxLength": 2048}
	item := object(map[string]any{
		"row_key": map[string]any{"type": "string", "pattern": "^run_[A-Za-z0-9_-]{43}$"},
		"id":      text, "resource_id": text, "resource_name": text,
		"status":            map[string]any{"type": "string", "enum": []string{"ok", "error", "planned", "pending_approval", "condition_failed", "passed", "stopped", "skipped", "unknown"}},
		"created_at":        map[string]any{"type": "string", "nullable": true, "format": "date-time"},
		"latency_ms":        map[string]any{"type": "integer", "nullable": true, "minimum": 0, "maximum": appRequestMaxSafeInteger},
		"cost_krw":          map[string]any{"type": "number", "nullable": true, "minimum": 0, "maximum": appRequestMaxCost},
		"receipt_available": map[string]any{"type": "boolean"},
	})
	page := object(map[string]any{"related_runs_version": map[string]any{"type": "integer", "enum": []int{1}}, "kind": map[string]any{"type": "string", "enum": []string{"workflow", "app"}}, "items": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("TraceRelatedRun")}, "total": map[string]any{"type": "integer", "minimum": 0, "maximum": appRequestMaxSafeInteger}, "limit": map[string]any{"type": "integer", "enum": []int{25, 50, 100}}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000}})
	return map[string]any{"TraceRelatedRun": item, "TraceRelatedRunPage": page}
}
