package proxy

func enrichDwRetryOpenAPI(method string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	for code, description := range map[string]string{"400": "Malformed review, query or required reason.", "401": "Existing admin authentication/scope rejection; readonly tokens cannot POST.", "403": "Job belongs to another authenticated actor.", "404": "No admitted job for this exact ID.", "409": "Review expired, evidence changed, no eligible work or another reviewed retry is active; read again, never automatically repeat a mutation.", "503": "Review, admission or durable job status unavailable. A lost response does not prove no admission: read the deterministic run_id."} {
		responses[code] = errorResponse(description)
	}
	if method == "get" {
		op["description"] = "Read-only preflight of the existing retry queue: closed source intervals and estimated row counts; no outbound ClickHouse call or audit mutation. Optional all=1 reviews the five existing rollup dimensions for the configured sink window instead. Review expires in five minutes and binds actor, queue generations, destination configuration and counts. A sole job_id query instead reads an admitted job owned by the same actor, across server pods. Expired worker leases are reported as interrupted without automatic redispatch. No private configuration, lease or worker token is returned. Responses are no-store."
		op["parameters"] = []any{map[string]any{"name": "all", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"0", "1"}}}, map[string]any{"name": "job_id", "in": "query", "schema": map[string]any{"type": "string", "pattern": "^dwr_[a-f0-9]{64}$"}, "description": "Mutually exclusive with all and other query keys."}}
		responses["200"] = successResponse("DwRetryReadResponse")
	} else {
		op["description"] = "Without reviewed=1, preserves the existing synchronous retry behavior and optional all=1 rollup backfill. Exactly reviewed=1 selects the strict reviewed request body (8 KiB maximum). Admission and required-reason audit are atomic; response is 202 with a durable job. The same actor/revision returns the existing job with 200 and never redispatches. Other active reviewed jobs reject overlapping admission. The background worker survives browser disconnection, is bounded to 30 minutes/server lifecycle, reports accepted rows and retained failures, and commits final status with its completion audit. External delivery is not exactly-once: a lost sink acknowledgment may require explicit re-review and destination deduplication. A terminal or expired job is never automatically resumed."
		op["parameters"] = []any{map[string]any{"name": "reviewed", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"1"}}}, map[string]any{"name": "all", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"0", "1"}}, "description": "Legacy POST only; mutually exclusive with reviewed."}}
		op["requestBody"] = map[string]any{"required": false, "content": jsonContent(schemaRef("DwRetryReviewedRequest")), "description": "Required only when reviewed=1. Legacy requests do not require or consume a body."}
		responses["200"] = successResponse("DwRetryWriteResponse")
		responses["202"] = successResponse("DwRetryRun")
	}
}
func dwRetryOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "format": "int64", "minimum": 0}
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	array := map[string]any{"type": "array", "maxItems": 64, "items": schemaRef("DwRetryDimension")}
	revision := map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	return map[string]any{
		"DwRetryDimension":       object([]string{"dimension", "since", "until", "estimated_rows", "sent_rows", "status", "issue"}, map[string]any{"dimension": text, "since": text, "until": text, "estimated_rows": count, "sent_rows": count, "status": map[string]any{"type": "string", "enum": []string{"queued", "blocked", "running", "succeeded", "failed", "pending", "not_run"}}, "issue": map[string]any{"type": "string", "enum": []string{"", "invalid_source_interval", "not_configured", "fact_not_configured", "delivery_incomplete", "completion_unconfirmed", "new_failure_queued", "operation_interrupted"}}}),
		"DwRetryReview":          object([]string{"revision", "run_id", "reviewed_at", "expires_at", "all", "eligible_dimensions", "estimated_rows", "dimensions"}, map[string]any{"revision": revision, "run_id": map[string]any{"type": "string", "pattern": "^dwr_[a-f0-9]{64}$"}, "reviewed_at": text, "expires_at": text, "all": map[string]any{"type": "boolean"}, "eligible_dimensions": count, "estimated_rows": count, "dimensions": array}),
		"DwRetryProgress":        object([]string{"estimated_rows", "sent_rows", "finished_dimensions", "dimensions"}, map[string]any{"estimated_rows": count, "sent_rows": count, "finished_dimensions": count, "dimensions": array}),
		"DwRetryRun":             object([]string{"id", "status", "reviewed_at", "created_at", "updated_at", "finished_at", "progress"}, map[string]any{"id": map[string]any{"type": "string", "pattern": "^dwr_[a-f0-9]{64}$"}, "status": map[string]any{"type": "string", "enum": []string{"running", "succeeded", "partial_failed", "failed", "interrupted"}}, "reviewed_at": text, "created_at": text, "updated_at": text, "finished_at": text, "progress": schemaRef("DwRetryProgress")}),
		"DwRetryReviewedRequest": object([]string{"revision", "reviewed_at", "all", "reason"}, map[string]any{"revision": revision, "reviewed_at": text, "all": map[string]any{"type": "boolean"}, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1024, "description": "Trimmed nonblank reason; length in Unicode code points."}}),
		"DwRetryLegacyResult":    object([]string{"recovered_dimensions", "sent_rows", "failed"}, map[string]any{"recovered_dimensions": count, "sent_rows": count, "failed": map[string]any{"type": "object", "additionalProperties": text}}),
		"DwRetryReadResponse":    map[string]any{"oneOf": []any{schemaRef("DwRetryReview"), schemaRef("DwRetryRun")}},
		"DwRetryWriteResponse":   map[string]any{"oneOf": []any{schemaRef("DwRetryLegacyResult"), schemaRef("DwRetryRun")}},
	}
}
