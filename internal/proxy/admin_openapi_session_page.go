package proxy

import "sort"

func enrichSessionPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Server-side session ID substring search within the caller's team and last N days, ending at response.to (exclusive). Search is case-insensitive and treats SQL wildcard characters literally; prompt text is not searched. Count, total usage and the current page share one SQL statement snapshot. Live pages can shift as new requests arrive. Usage records contribute tokens/cost without multiplying request counts. Ordering is UTC last activity at nanosecond precision, then binary session ID descending. Stored redacted last-user-message previews are additionally masked for every caller. Unsafe session IDs are null and cannot open a recorder. A three-second query deadline and no-store apply. The legacy /admin/sessions response is unchanged."
	op["parameters"] = []any{
		map[string]any{"name": "days", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 365, "default": 7}},
		map[string]any{"name": "q", "in": "query", "schema": map[string]any{"type": "string", "maxLength": 256}, "description": "Session ID only; maximum 256 UTF-8 bytes. Sensitive text is rejected; not echoed in the response."},
		map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "enum": []int{25, 50, 100}, "default": 25}},
		map[string]any{"name": "offset", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}, "description": "Must be a multiple of limit."},
	}
	responses["200"] = map[string]any{"description": "Session page and full matching totals", "content": jsonContent(schemaRef("SessionExplorerPage"))}
	for status, description := range map[string]string{"400": "Invalid, unknown or duplicate query parameter", "401": "Administrator read required", "405": "GET required", "500": "Query failed; no partial totals"} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}
func sessionPageSchemas() map[string]any {
	object := func(properties map[string]any) map[string]any {
		required := []string{}
		for key := range properties {
			required = append(required, key)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
	}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": appRequestMaxSafeInteger}
	cost := map[string]any{"type": "number", "minimum": 0, "maximum": appRequestMaxCost}
	date := map[string]any{"type": "string", "format": "date-time"}
	row := object(map[string]any{"row_key": map[string]any{"type": "string", "pattern": "^session_[A-Za-z0-9_-]{43}$"}, "session_id": map[string]any{"type": "string", "nullable": true, "maxLength": 1024}, "requests": count, "first_seen": date, "last_seen": date, "models": count, "api_keys": count, "errors": count, "total_tokens": count, "cost_krw": cost, "last_message": map[string]any{"type": "string", "maxLength": 160}})
	summary := object(map[string]any{"sessions": count, "requests": count, "errors": count, "total_tokens": count, "cost_krw": cost})
	page := object(map[string]any{"session_page_version": map[string]any{"type": "integer", "enum": []int{1}}, "days": map[string]any{"type": "integer", "minimum": 1, "maximum": 365}, "limit": map[string]any{"type": "integer", "enum": []int{25, 50, 100}}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000}, "from": date, "to": date, "sessions": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("SessionExplorerRow")}, "summary": schemaRef("SessionExplorerSummary")})
	return map[string]any{"SessionExplorerRow": row, "SessionExplorerSummary": summary, "SessionExplorerPage": page}
}
