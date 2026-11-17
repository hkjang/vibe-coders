package proxy

func enrichAuditCSVOpenAPI(op, responses map[string]any) {
	op["description"] = "Exports existing administrator audit and alert event records as UTF-8 CSV with one BOM and six columns. Requires existing admin read access. Raw-view permission controls the existing redaction projection; CSV text cells are protected against spreadsheet formula evaluation after projection. The limit applies separately to audit and alert rows, not to their combined count. This bounded current export does not share a snapshot with a previous screen query."
	op["parameters"] = []any{map[string]any{
		"name": "limit", "in": "query", "required": false,
		"description": "Per-kind row limit. Missing, invalid or non-positive values use 1000; values above 10000 clamp to 10000.",
		"schema":      map[string]any{"type": "integer", "default": 1000},
	}}
	responses["200"] = map[string]any{
		"description": "CSV columns: created_at, kind, actor, action, detail_before, detail_after. Administrator audit rows precede alert event rows; empty results include the header. Timestamps use ISO 8601.",
		"content":     map[string]any{"text/csv": map[string]any{"schema": map[string]any{"type": "string"}}},
		"headers": map[string]any{
			"Cache-Control":       map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}},
			"Content-Disposition": map[string]any{"schema": map[string]any{"type": "string"}, "description": "Attachment filename audit-YYYYMMDD-HHMMSS.csv"},
		},
	}
	for status, description := range map[string]string{
		"401": "invalid_api_key: existing admin read access is required",
		"405": "method_not_allowed: only GET is supported",
		"500": "audit_export_failed: no successful CSV is returned",
	} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}
