package proxy

import "strings"

func enrichMeConsoleOpenAPI(route, method string, op, responses map[string]any) {
	names := map[string]string{
		"/me/dashboard": "MeConsoleDashboard", "/me/actions": "MeConsoleActions", "/me/notifications": "MeConsoleNotifications",
		"/me/report": "MeConsoleReport", "/me/requests": "MeConsoleRequests", "/me/requests/{id}/receipt": "MeConsoleReceipt",
		"/me/recommended-models": "MeConsoleModels", "/me/skills": "MeConsoleSkills", "/me/recommendations": "MeConsoleRecommendations",
	}
	op["description"] = "Existing personal self-service API. Resolves the caller from a JWT subject or an owned proxy API key; does not require admin:read. User query overrides are not accepted. Responses are no-store. Reads are independent, not an atomic snapshot; missing or failed optional measurements are not confirmed zeros."
	if strings.HasPrefix(route, "/me/skills") || route == "/me/recommended-models" {
		op["description"] = "Existing self-service API requiring a JWT subject (not a proxy API key); does not require admin:read. Uses the JWT team for skill visibility and model evaluation. Responses are no-store. Skill run statistics cover all users over 30 days; satisfaction covers all stored feedback. These are not personal execution statistics."
	}
	parameters, _ := op["parameters"].([]any)
	query := func(name string, schema map[string]any, description string) {
		parameters = append(parameters, map[string]any{"name": name, "in": "query", "required": false, "schema": schema, "description": description})
	}
	if route == "/me/recommendations" {
		query("refresh", map[string]any{"type": "boolean", "default": true}, "Only the literal false reads the caller's stored recommendations without side effects. Omitted/true preserves legacy generation and replaces stored IDs. Generation is not idempotent and must not be automatically replayed, including after 401.")
	}
	if route == "/me/requests" {
		query("limit", map[string]any{"type": "integer", "default": 20}, "Newest request metadata, at most 100 rows. Values outside 1..100 or invalid/missing use 20. No server pagination or total history count.")
	}
	if route == "/me/report" {
		query("window", map[string]any{"type": "string", "enum": []string{"weekly", "monthly"}, "default": "weekly"}, "Rolling 7 days (weekly) or 30 days (monthly), compared with the previous equal-length interval; unknown input uses weekly. Dashboard today/month use UTC calendar boundaries instead.")
	}
	if len(parameters) > 0 {
		op["parameters"] = parameters
	}
	status := "200"
	responseName := names[route]
	if method == "post" {
		bodyName := "MeConsoleRecommendationFeedback"
		responseName = "MeConsoleRecommendationFeedbackResult"
		switch route {
		case "/me/actions/snooze":
			bodyName = "MeConsoleSnooze"
			responseName = "MeConsoleSnoozeResult"
		case "/me/skills/{name}/request-access":
			bodyName = "MeConsoleSkillRequest"
			responseName = "MeConsoleSkillActionResult"
			status = "201"
		case "/me/skills/{name}/feedback":
			bodyName = "MeConsoleSkillFeedback"
			responseName = "MeConsoleSkillActionResult"
			status = "201"
		}
		op["requestBody"] = requestBody(bodyName)
		op["description"] = op["description"].(string) + " Writes use the existing server authorization and have no idempotency token. A lost acknowledgment must not trigger automatic retry. Recommendation feedback is tied to a currently stored recommendation owned by this caller, returns status/kind/action, and does not regenerate the list."
	}
	responses[status] = successResponse(responseName)
	responses[status].(map[string]any)["headers"] = map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}
	for code, description := range map[string]string{"400": "Invalid input", "401": "Caller not identified", "403": "Resource belongs to another caller", "404": "Resource not found or recommendation replaced", "405": "Unsupported method", "500": "Required data or write failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func meConsoleOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer"}
	number := map[string]any{"type": "number"}
	ratio := map[string]any{"type": "number", "minimum": 0, "maximum": 1}
	flag := map[string]any{"type": "boolean"}
	object := func(p map[string]any) map[string]any { return map[string]any{"type": "object", "properties": p} }
	list := func(item map[string]any) map[string]any {
		return map[string]any{"type": "array", "nullable": true, "items": item}
	}
	partial := func(codes ...string) map[string]any {
		return map[string]any{"type": "array", "uniqueItems": true, "items": map[string]any{"type": "string", "enum": codes}, "description": "Unavailable optional components. Their zero/empty values must not be presented as confirmed measurements."}
	}
	own := func(p map[string]any) map[string]any {
		p["user_id"] = text
		return map[string]any{"type": "object", "required": []string{"user_id"}, "properties": p}
	}
	model := object(map[string]any{"model": text, "requests": count, "avg_cost_krw": number, "success_rate": ratio})
	grouped := list(object(map[string]any{"key": text, "requests": count}))
	totals := object(map[string]any{"requests": count, "tokens": count, "cost_krw": number, "errors": count})
	profile := object(map[string]any{"success_rate": ratio, "avg_latency_ms": number, "cache_rate": ratio, "text2sql_usage_rate": ratio, "mcp_usage_rate": ratio, "risk_score": number, "summary": text, "since": text, "top_task_types": grouped, "top_models": grouped, "top_languages": grouped, "top_mcp_tools": grouped})
	skill := object(map[string]any{"name": text, "description": text, "risk_level": text, "runs_30d": count, "users_30d": count,
		"success_rate": map[string]any{"type": "number", "minimum": 0, "maximum": 100, "description": "Percentage, not a fraction. Zero runs means no observed success rate."},
		"satisfaction": map[string]any{"type": "number", "minimum": 0, "maximum": 5, "description": "Average rating; zero feedback_count means unobserved."}, "feedback_count": count})
	action := map[string]any{"type": "string", "enum": []string{"adopted", "dismissed", "later"}}
	return map[string]any{
		"MeConsoleDashboard": own(map[string]any{"today": totals, "month": totals, "profile": profile, "frequent_models": list(model), "potential_savings_krw": number, "potential_savings_model": text,
			"recent_failures":        list(object(map[string]any{"id": text, "model": text, "status_code": count, "error": text, "task_type": text, "created_at": text})),
			"recommended_templates":  list(object(map[string]any{"id": text, "name": text, "category": text, "description": text})),
			"recent_prompt_products": list(object(map[string]any{"id": text, "name": text, "description": text})),
			"key_alerts":             list(object(map[string]any{"id": text, "name": text, "user_id": text, "team": text, "expires_at": text, "last_used_at": text, "days_idle": count, "flags": list(text), "severity": text})),
			"recent_blocks":          list(object(map[string]any{"rule": text, "reason": text, "model": text, "endpoint": text, "created_at": text})),
			"my_saved_reports":       list(object(map[string]any{"id": text, "name": text, "schema_name": text, "kind": text, "visibility": text, "approval_status": text, "created_at": text})),
			"partial_failures":       partial("blocks", "reports"),
		}),
		"MeConsoleActions":       own(map[string]any{"count": count, "actions": list(object(map[string]any{"type": text, "severity": text, "message": text, "button_label": text, "button_href": text})), "partial_failures": partial("snoozes", "keys", "usage_week", "usage_day", "usage_month", "models", "candidates", "mcp", "profile", "recommendations")}),
		"MeConsoleNotifications": own(map[string]any{"count": count, "critical_count": count, "notifications": list(object(map[string]any{"category": text, "level": text, "title": text, "detail": text, "created_at": text, "href": text})), "partial_failures": partial("recommendations", "keys", "failures", "policy", "secrets")}),
		"MeConsoleReport":        own(map[string]any{"window": map[string]any{"type": "string", "enum": []string{"weekly", "monthly"}}, "since": text, "requests": count, "tokens": count, "cost_krw": number, "errors": count, "success_rate": ratio, "prior_cost_krw": number, "prior_requests": count, "cost_delta_ratio": number, "avg_latency_ms": number, "cache_rate": ratio, "risk_score": number, "top_models": list(model), "top_task_types": grouped, "potential_savings_krw": number, "potential_savings_model": text, "recommendation_count": count, "partial_failures": partial("models", "profile", "recommendations")}),
		"MeConsoleRequests":      object(map[string]any{"requests": list(object(map[string]any{"id": text, "model": text, "provider": text, "endpoint": text, "status_code": count, "cost_krw": number, "total_tokens": count, "cached": flag, "created_at": text}))}),
		"MeConsoleReceipt": object(map[string]any{"request_id": text, "created_at": text, "endpoint": text, "model": text, "provider": text, "status_code": count, "finish_reason": text, "latency_ms": number, "cost_krw": number, "cache_hit": flag,
			"tokens":  object(map[string]any{"prompt": count, "completion": count, "total": count, "cached": count}),
			"routing": object(map[string]any{"requested_model": text, "selected_model": text, "selected_provider": text, "reason": text, "fallback_path": list(text), "risk_tier": text, "complexity_tier": text}),
			"blocked": flag, "policy": list(object(map[string]any{"decision": text, "rule": text, "reason": text})), "mcp_used": flag, "mcp_tools": list(object(map[string]any{"server": text, "tool": text, "error": flag})), "skill_used": flag, "skills": list(text), "note": text, "partial_failures": partial("routing", "policy", "tools"),
		}),
		"MeConsoleModels": object(map[string]any{"note": text, "tagged_model_count": count,
			"task_recommendations": list(object(map[string]any{"task_type": text, "requests": count, "recommend": list(text), "avoid": list(text)})),
			"your_models":          list(object(map[string]any{"model": text, "requests": count, "tags": object(map[string]any{"good_for": text, "avoid_for": text, "risk_note": text})})),
			"team_winners":         list(object(map[string]any{"model": text, "wins": count, "avg_score": number, "appearances": count})), "partial_failures": partial("team_winners"),
		}),
		"MeConsoleSkills":                       object(map[string]any{"team": text, "available": list(skill), "requestable": list(skill), "partial_failures": partial("runs", "feedback")}),
		"MeConsoleRecommendations":              own(map[string]any{"recommendations": list(object(map[string]any{"id": text, "user_id": text, "kind": text, "ref": text, "title": text, "detail": text, "est_savings_krw": number, "created_at": text}))}),
		"MeConsoleSnooze":                       map[string]any{"type": "object", "required": []string{"type"}, "properties": map[string]any{"type": text, "days": map[string]any{"type": "integer", "description": "Values outside 1..90 default to 7 days."}}},
		"MeConsoleSnoozeResult":                 map[string]any{"type": "object", "required": []string{"type", "snoozed_until"}, "properties": map[string]any{"type": text, "snoozed_until": text}},
		"MeConsoleSkillRequest":                 object(map[string]any{"reason": text}),
		"MeConsoleSkillFeedback":                map[string]any{"type": "object", "required": []string{"rating"}, "properties": map[string]any{"rating": map[string]any{"type": "integer", "minimum": 1, "maximum": 5}, "comment": text}},
		"MeConsoleSkillActionResult":            map[string]any{"type": "object", "required": []string{"status", "skill"}, "properties": map[string]any{"status": map[string]any{"type": "string", "enum": []string{"requested", "recorded"}}, "skill": text}},
		"MeConsoleRecommendationFeedback":       map[string]any{"type": "object", "required": []string{"action"}, "properties": map[string]any{"id": text, "action": map[string]any{"type": "string", "description": "adopted, dismissed or later; legacy aliases accepted/rejected/accept/reject/adopt/dismiss/snooze/snoozed remain supported, case-insensitive and trimmed. Body id is required for the legacy /feedback alias and ignored when a path ID is present."}, "reason": text}},
		"MeConsoleRecommendationFeedbackResult": map[string]any{"type": "object", "required": []string{"status", "kind", "action"}, "properties": map[string]any{"status": map[string]any{"type": "string", "enum": []string{"recorded"}}, "kind": text, "action": action}},
	}
}
