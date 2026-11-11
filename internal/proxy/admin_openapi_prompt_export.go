package proxy

func enrichPromptExportOpenAPI(op, responses map[string]any) {
	op["description"] = "Exports request metadata, not prompt bodies, as UTF-8 CSV with a BOM and 21 legacy columns. Requires admin read access and applies the same team scope and raw-prompt search permission as /admin/prompts. Empty team scope yields no rows; a scope lookup failure never falls back to a global export. Caller-visible metadata is masked before export. Text cells beginning with spreadsheet formulas are prefixed with an apostrophe; numeric cells retain their numeric representation. This is a bounded current query, not a paginated export or a snapshot shared with a prior search response."
	parameters := []any{}
	for _, parameter := range []struct{ name, description string }{
		{"q", "Trimmed keyword or tag search. Raw prompt text is searchable only with raw-view permission; otherwise only redacted prompt text is searched."},
		{"language", "Optional programming language filter."},
		{"ip", "Optional client IP filter; does not widen the caller's team scope."},
		{"api_key_id", "Optional API key identifier filter; does not widen the caller's team scope."},
		{"since", "Optional lower timestamp bound. Clients should send an ISO 8601 timestamp with a timezone; the existing handler forwards the trimmed string without format validation."},
		{"limit", "Optional decimal row limit. Empty, non-integer or non-positive values use 1000; values above 10000 clamp to 10000. Independent of /admin/prompts, whose limit is capped at 200."},
	} {
		parameters = append(parameters, map[string]any{"name": parameter.name, "in": "query", "required": false,
			"description": parameter.description, "schema": map[string]any{"type": "string"}})
	}
	op["parameters"] = parameters
	responses["200"] = map[string]any{
		"description": "CSV columns: created_at, trace_id, request_id, endpoint, provider, model, api_key_id, client_ip, status_code, first_chunk_ms, latency_ms, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, total_tokens, cost_krw, token_source, stream, languages, error. Empty results contain only the header. Cost is KRW with two decimal places; languages are joined with |.",
		"content":     map[string]any{"text/csv": map[string]any{"schema": map[string]any{"type": "string"}}},
		"headers": map[string]any{
			"Cache-Control":       map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}},
			"Content-Disposition": map[string]any{"description": "Attachment filename requests-YYYYMMDD-HHMMSS.csv", "schema": map[string]any{"type": "string"}},
		},
	}
	for status, description := range map[string]string{
		"401": "invalid_api_key: admin read authentication is required",
		"405": "method_not_allowed: only GET is supported; Allow: GET",
		"500": "prompt_scope_failed or export_failed: no successful export; the error does not expose database details",
	} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}
