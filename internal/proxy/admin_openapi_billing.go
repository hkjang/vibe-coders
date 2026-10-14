package proxy

func enrichBillingDashboardOpenAPI(op, responses map[string]any) {
	op["description"] = "Read-only organization cost view requiring admin:read when authentication is enabled. Totals use the existing exact aggregate over retained request_logs since the requested window, including models outside the top-20 lists and requests without token usage. Retention removes records from these totals; this is not a complete billing ledger. Reads are separate, not an atomic snapshot. Cost-center and model lists each return at most 20 rows ordered by cost. Budgets always describe the current month, independently of window. Migration advice considers the 10 busiest prompt clusters with at least 20 requests; estimated savings sum only returned candidates, not guaranteed or organization-wide savings. A total-read failure returns 503 without data. Optional-section failures retain healthy sections, discard partial failed rows, and name failed fields in unavailable_sections; failed lists are null and failed migration savings are zero, not a confirmed zero. New servers emit totals_scope=all_retained_requests; its absence identifies older top-model-only totals."
	op["parameters"] = []any{map[string]any{"name": "window", "in": "query", "schema": map[string]any{"type": "string", "default": "30d"}, "description": "Existing parseWindow rules: 1h, 6h, 24h/1d, 7d, 30d or a Go duration; omitted/invalid defaults to 30 days. No upper time bound or pagination."}}
	responses["200"] = successResponse("BillingDashboardResponse")
	for status, description := range map[string]string{"403": "admin:read scope required", "405": "GET required", "503": "billing_dashboard_unavailable: totals cannot be read; no partial data or storage error details returned"} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func billingDashboardOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	number := map[string]any{"type": "number"}
	count := map[string]any{"type": "integer"}
	object := func(properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "properties": properties}
	}
	list := func(name string) map[string]any {
		return map[string]any{"type": "array", "nullable": true, "items": schemaRef(name)}
	}
	return map[string]any{
		"BillingDashboardResponse": map[string]any{
			"type": "object", "required": []string{"since", "total_cost_krw", "total_requests", "by_cost_center", "by_model", "budgets", "migration_candidates", "estimated_savings_krw"},
			"properties": map[string]any{
				"since": text, "total_cost_krw": number, "total_requests": count,
				"totals_scope":   map[string]any{"type": "string", "enum": []string{"all_retained_requests"}},
				"by_cost_center": list("BillingCostRow"), "by_model": list("BillingCostRow"),
				"budgets": list("BillingBudgetStatus"), "migration_candidates": list("BillingMigrationCandidate"), "estimated_savings_krw": number,
				"unavailable_sections": map[string]any{"type": "array", "uniqueItems": true, "items": map[string]any{"type": "string", "enum": []string{"by_cost_center", "by_model", "budgets", "migration_candidates"}}},
			},
		},
		"BillingCostRow": object(map[string]any{"key": text, "requests": count, "tokens": count, "cost_krw": number, "error_requests": count}),
		"BillingBudgetStatus": object(map[string]any{
			"budget":    object(map[string]any{"id": text, "scope": text, "scope_value": text, "monthly_krw": number, "note": text, "created_at": text}),
			"spent_krw": number, "burn_ratio": number, "projected_krw": number, "projected_ratio": number,
			"days_elapsed": number, "days_in_month": number, "exhaustion_date": text, "on_track": map[string]any{"type": "boolean"},
		}),
		"BillingMigrationCandidate": object(map[string]any{
			"fingerprint": text, "task_type": text, "requests": count, "current_model": text, "recommended_model": text,
			"current_avg_cost_krw": number, "recommended_avg_cost_krw": number, "current_success_rate": number,
			"recommended_success_rate": number, "estimated_savings_krw": number,
		}),
	}
}
