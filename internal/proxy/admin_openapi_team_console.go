package proxy

func enrichTeamConsoleOpenAPI(route, method string, op, responses map[string]any) {
	names := map[string]string{
		"/team/dashboard": "TeamConsoleDashboard", "/team/reports": "TeamConsoleReports",
		"/team/portal": "TeamConsolePortal", "/team/risk": "TeamConsoleRisk",
		"/team/onboarding": "TeamConsoleOnboarding", "/team/savings-challenge": "TeamConsoleSavings",
		"/team/skills/popular": "TeamConsoleSkills", "/team/templates/candidates": "TeamConsoleCandidates",
	}
	op["description"] = "Team-scoped existing self-service API. With authentication enabled, requires team:read; admin:read additionally permits the team query override. Without authentication an explicit team query is required. Usage may match team ID and name; report/risk membership uses the resolved input team exactly. Scope lookup failure returns an error rather than broadening access. Responses are no-store. Reads are independent, not an atomic snapshot; lists are bounded where stated, not server-paginated."
	parameters := []any{map[string]any{"name": "team", "in": "query", "required": false, "schema": map[string]any{"type": "string"}, "description": "Optional team ID or name override, honored only with admin:read or when authentication is disabled."}}
	if method == "get" && route != "/team/reports" && route != "/team/savings-challenge" {
		parameters = append(parameters, map[string]any{"name": "window", "in": "query", "required": false, "schema": map[string]any{"type": "string"}, "description": "Existing parseWindow syntax. Default 7d for risk, 90d for onboarding, 30d otherwise; no upper timestamp bound. Supports 7d and 30d; the UI sends 2160h for 90 days because parseWindow does not recognize 90d. Other Go durations, including nonpositive ones, retain existing handler behavior."})
	}
	if route == "/team/templates/candidates" {
		parameters = append(parameters, map[string]any{"name": "min_count", "in": "query", "schema": map[string]any{"type": "integer", "default": 3}, "description": "Minimum repeated requests; missing/invalid uses 3 and the store clamps values below 2 to 2. Maximum 15 candidates."})
	}
	op["parameters"] = parameters
	responses["200"] = successResponse(names[route])
	if method == "post" {
		op["description"] = "Decides a report belonging exactly to the selected team. Uses the same existing team:read authorization as GET; admin:read permits a team override. action is trimmed/case-insensitive approve or reject. Optional reason is trimmed, at most 500 Unicode characters, and included in the existing best-effort admin audit. Legacy callers may omit reason. The server does not require a pending status or an expected revision: revision is a UI preflight comparison aid, not atomic compare-and-swap or idempotency. No automatic retry is safe."
		op["requestBody"] = requestBody("TeamConsoleDecision")
		responses["200"] = successResponse("TeamConsoleDecisionResult")
		responses["404"] = map[string]any{"description": "Report does not exist in the selected team", "content": jsonContent(schemaRef("AppError"))}
	}
	for status, description := range map[string]string{"400": "No associated team, invalid JSON, invalid action or reason", "401": "Access token required", "403": "team:read scope required", "405": "Unsupported method", "500": "Scope or required data could not be read, or decision failed"} {
		responses[status] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	response := responses["200"].(map[string]any)
	response["headers"] = map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}
}

func teamConsoleOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	metric := map[string]any{"type": "number"}
	count := map[string]any{"type": "integer"}
	flag := map[string]any{"type": "boolean"}
	object := func(p map[string]any) map[string]any { return map[string]any{"type": "object", "properties": p} }
	list := func(item map[string]any) map[string]any {
		return map[string]any{"type": "array", "nullable": true, "items": item}
	}
	envelope := func(p map[string]any) map[string]any {
		p["team_id"] = text
		p["since"] = text
		return map[string]any{"type": "object", "required": []string{"team_id"}, "properties": p}
	}
	partial := func(codes ...string) map[string]any {
		return map[string]any{"type": "array", "uniqueItems": true, "items": map[string]any{"type": "string", "enum": codes}, "description": "Unavailable components. Zero/empty values for those components are not confirmed measurements."}
	}
	model := object(map[string]any{"model": text, "requests": count, "cost_krw": metric})
	skill := object(map[string]any{"skill_name": text, "runs": count, "ok": count, "errors": count, "success_rate": metric, "total_cost_krw": metric, "avg_latency_ms": metric})
	totals := object(map[string]any{"requests": count, "tokens": count, "cost_krw": metric, "errors": count, "avg_latency_ms": metric, "success_rate": metric})
	return map[string]any{
		"TeamConsoleDashboard": envelope(map[string]any{"dashboard": object(map[string]any{
			"team_keys": list(text), "totals": totals,
			"top_users": list(object(map[string]any{"user_id": text, "requests": count, "cost_krw": metric, "errors": count})),
			"models":    list(model), "recent_failures": list(object(map[string]any{"id": text, "model": text, "status_code": count, "error": text, "created_at": text})),
		})}),
		"TeamConsoleReports": envelope(map[string]any{"reports": list(schemaRef("TeamConsoleReport"))}),
		"TeamConsoleReport": object(map[string]any{
			"id": text, "name": text, "question": text, "sql": text, "schema_name": text, "kind": text, "created_by": text, "created_at": text,
			"schedule_interval": text, "schedule_enabled": flag, "deliver_mattermost": flag, "last_run_at": text,
			"team": text, "visibility": text, "approval_status": text, "approved_by": text, "approved_at": text,
			"revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "SHA-256 of the stored report fields. Changes even when a changed field is masked by the frontend; not a conditional-write token."},
		}),
		"TeamConsoleDecision": map[string]any{"type": "object", "required": []string{"report_id", "action"}, "properties": map[string]any{
			"report_id": text, "action": map[string]any{"type": "string", "enum": []string{"approve", "reject"}},
			"reason": map[string]any{"type": "string", "maxLength": 500, "description": "Optional for legacy compatibility. New UI requires a nonempty nonsecret reason."},
		}},
		"TeamConsoleDecisionResult": map[string]any{"type": "object", "required": []string{"report_id", "approval_status"}, "properties": map[string]any{
			"report_id": text, "approval_status": map[string]any{"type": "string", "enum": []string{"approved", "rejected"}},
		}},
		"TeamConsoleSavings": envelope(map[string]any{"month_to_date_krw": metric, "projected_month_end_krw": metric, "last_month_krw": metric, "projected_savings_krw": metric, "on_track": flag, "days_elapsed": count, "days_in_month": count}),
		"TeamConsoleOnboarding": envelope(map[string]any{"recommended_models": list(model), "recommended_skills": list(skill),
			"recommended_mcp": list(object(map[string]any{"server_label": text, "tool_name": text, "ref": text, "calls": count, "errors": count, "success_rate": metric, "avg_latency_ms": metric})),
			"note":            text, "partial_failures": partial("models", "skills", "mcp")}),
		"TeamConsoleRisk": envelope(map[string]any{"blocked": count, "warned": count, "blocked_prior_window": count, "blocked_trend": count,
			"secrets_total": count, "secrets_by_type": map[string]any{"type": "object", "additionalProperties": count}, "pending_approvals": count,
			"recent_violations": list(object(map[string]any{"decision": text, "reason": text, "rule": text, "endpoint": text, "risk_score": metric, "created_at": text})),
			"partial_failures":  partial("policy_current", "policy_prior", "secrets", "approvals")}),
		"TeamConsoleSkills":     envelope(map[string]any{"skills": list(skill)}),
		"TeamConsoleCandidates": envelope(map[string]any{"candidates": list(object(map[string]any{"fingerprint": text, "task_type": text, "requests": count, "avg_cost_krw": metric, "success_rate": metric, "already_product": flag}))}),
		"TeamConsolePortal": envelope(map[string]any{"usage": totals, "budgets": list(object(map[string]any{"monthly_krw": metric, "spent_krw": metric, "burn_ratio": metric, "projected_krw": metric, "projected_ratio": metric, "on_track": flag, "exhaustion_date": text, "note": text})),
			"api_keys":      list(object(map[string]any{"id": text, "name": text, "owner": text, "user_id": text, "role": text, "status": text, "expires_at": text, "budget_limit_krw": metric})),
			"api_key_count": count, "members": list(text), "member_count": count,
			"accessible_skills": list(object(map[string]any{"name": text, "description": text, "version": text, "risk_level": text})),
			"skill_count":       count, "pending_skill_requests": list(object(map[string]any{"id": text, "skill_name": text, "user_id": text, "reason": text, "created_at": text})),
			"note": text, "partial_failures": partial("budgets", "keys", "skills", "requests"),
		}),
	}
}
