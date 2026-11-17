package proxy

import "slices"

func enrichActivitySummaryOpenAPI(route string, op, responses map[string]any) {
	names := map[string]string{
		"/admin/incidents/summary":  "IncidentActivityResponse",
		"/admin/alerts/summary":     "AlertActivityResponse",
		"/admin/audit-logs/summary": "AuditActivityResponse",
	}
	op["description"] = "Global admin:read metadata projection of existing operational records. GET only; no-store. Strict window defaults to 24h; interval [since, generated_at). Alerts and audit return at most five latest rows, with has_more determined by a sixth row; these are not total counts. Audit labels use a finite vocabulary; actor, before/after, rule names, webhook and delivery error text are never selected or returned. Incident summary reuses existing hourly failover/5xx clustering at minimum five events; current_hour means the latest qualifying UTC bucket touches the observation hour, not confirmed ongoing incident status. Returns five signals prioritising current hour, then start time. Counts cover all qualifying groups in the interval; actor counts are omitted. Failover and 5xx counts may overlap. Bucket boundaries may extend beyond the selected interval. No mutation or probe is performed."
	op["parameters"] = []any{map[string]any{"name": "window", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"1h", "24h", "7d", "30d"}, "default": "24h"}}}
	responses["200"] = successResponse(names[route])
	for _, code := range []string{"400", "401", "403", "405", "500"} {
		responses[code] = map[string]any{"description": "Summary unavailable; no storage details echoed.", "content": jsonContent(schemaRef("AppError"))}
	}
}

func activitySummaryOpenAPISchemas() map[string]any {
	object := func(fields map[string]any) map[string]any {
		required := make([]string, 0, len(fields))
		for name := range fields {
			required = append(required, name)
		}
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	enum := func(values ...string) map[string]any { return map[string]any{"type": "string", "enum": values} }
	stamp := map[string]any{"type": "string", "format": "date-time"}
	count := map[string]any{"type": "integer", "minimum": 0}
	boolean := map[string]any{"type": "boolean"}
	number := map[string]any{"type": "number"}
	array := func(item map[string]any) map[string]any {
		return map[string]any{"type": "array", "maxItems": 5, "items": item}
	}
	response := func(fields map[string]any) map[string]any {
		fields["window"] = enum("1h", "24h", "7d", "30d")
		fields["since"], fields["generated_at"] = stamp, stamp
		return object(fields)
	}
	metrics := []string{"other"}
	for metric := range validAlertMetrics {
		metrics = append(metrics, metric)
	}
	slices.Sort(metrics)
	return map[string]any{
		"AuditActivityResponse": response(map[string]any{
			"has_more": boolean,
			"changes": array(object(map[string]any{
				"category":  enum("provider", "model", "routing", "policy", "alert", "access", "mcp", "text2sql", "settings", "cost", "other"),
				"operation": enum("create", "update", "delete", "enable", "disable", "revoke", "rotate", "approve", "reject", "import", "rollback", "test", "other"), "created_at": stamp,
			})),
		}),
		"AlertActivityResponse": response(map[string]any{
			"has_more": boolean,
			"events":   array(object(map[string]any{"metric": enum(metrics...), "value": number, "threshold": number, "delivered": boolean, "delivery_failed": boolean, "created_at": stamp})),
		}),
		"IncidentActivityResponse": response(map[string]any{
			"total": count, "current_hour": count, "min_events": map[string]any{"type": "integer", "enum": []int{5}},
			"signals": array(object(map[string]any{
				"provider": map[string]any{"type": "string"}, "started_at": stamp, "ended_at": stamp,
				"failovers": count, "errors_5xx": count, "requests": count, "current_hour": boolean,
			})),
		}),
	}
}
