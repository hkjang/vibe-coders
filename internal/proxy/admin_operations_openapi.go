package proxy

func enrichAdminOperationOpenAPI(route, method string, op, responses map[string]any) {
	response := "RetentionStatus"
	if route == "/admin/fallback" {
		response = "FallbackStats"
		if method == "post" {
			response = "FallbackReplayResult"
		}
	}
	responses["200"] = successResponse(response)
	responses["503"] = map[string]any{"description": "Status or audit unavailable, or an incomplete operation. A failed response does not prove no side effects occurred.", "content": jsonContent(schemaRef("AppError"))}
	if method == "post" {
		op["requestBody"] = map[string]any{"required": false, "content": jsonContent(schemaRef("AdminOperationRequest"))}
		op["description"] = "Existing admin write permission required. Empty bodies and empty objects remain supported for the legacy console. Supplied reason must be nonblank after trimming and at most 1024 Unicode characters; whole body limit 8192 bytes. Intent audit must persist before execution. Completion audit has a separate bounded lifetime. Cleanup/replay and audit are not an atomic transaction, and retries are not idempotent. Inspect current state and audit before any deliberate retry after a failed or missing response."
		responses["400"] = map[string]any{"description": "Invalid operation reason", "content": jsonContent(schemaRef("AppError"))}
	}
}

func adminOperationOpenAPISchemas() map[string]any {
	integer := map[string]any{"type": "integer", "format": "int64", "minimum": 0}
	days := map[string]any{"type": "integer", "description": "Retention days; nonpositive values disable this age threshold."}
	text := map[string]any{"type": "string"}
	object := func(properties map[string]any, required []string) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
	}
	return map[string]any{
		"AdminOperationRequest": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
			"reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1024, "description": "Trimmed audit reason. Omission is for legacy compatibility; new console confirmations send this field."},
		}},
		"RetentionStatus": object(map[string]any{
			"request_days": days, "prompt_days": days, "response_days": days,
			"requests": integer, "prompts": integer, "responses": integer,
			"last_run_at": text, "last_deleted": map[string]any{"type": "integer", "format": "int64", "minimum": 0, "description": "Cumulative deletion count in this worker process, not the count of the last run."},
		}, []string{"request_days", "prompt_days", "response_days", "requests", "prompts", "responses", "last_run_at", "last_deleted"}),
		"FallbackStats": object(map[string]any{
			"path": text, "exists": map[string]any{"type": "boolean"}, "bytes": integer, "lines": integer, "modified_at": text,
		}, []string{"path", "exists", "bytes", "lines", "modified_at"}),
		"FallbackReplayResult": object(map[string]any{
			"path": text, "imported": integer, "duplicates": integer, "failed": integer, "remaining": integer, "removed": map[string]any{"type": "boolean"},
		}, []string{"path", "imported", "duplicates", "failed", "remaining", "removed"}),
	}
}
