package proxy

func routingDraftOpenAPISchemas() map[string]any {
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	text := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer"}
	flag := map[string]any{"type": "boolean"}
	revision := map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	patch := object(nil, map[string]any{
		"priority":        map[string]any{"type": "integer", "minimum": 1, "maximum": 10000},
		"match_pattern":   map[string]any{"type": "string", "maxLength": 200},
		"min_complexity":  map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
		"max_complexity":  map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
		"target_model":    map[string]any{"type": "string", "minLength": 1, "maxLength": 256},
		"target_provider": map[string]any{"type": "string", "maxLength": 120},
		"note":            map[string]any{"type": "string", "maxLength": 500},
	})
	delete(patch, "required")
	patch["minProperties"] = 1
	request := object([]string{"model", "messages"}, map[string]any{
		"model":      map[string]any{"type": "string", "minLength": 1, "maxLength": 256},
		"api_key_id": map[string]any{"type": "string", "maxLength": 2048, "description": "Optional existing policy key ID; own-team restriction is enforced. Not an API key secret."},
		"messages":   map[string]any{"type": "array", "minItems": 1, "maxItems": 64, "items": object([]string{"role", "content"}, map[string]any{"role": map[string]any{"type": "string", "enum": []string{"user", "assistant", "system", "developer"}}, "content": map[string]any{"type": "string", "description": "At most 65536 UTF-8 bytes per message. Never persisted by preview."}})},
	})
	plan := object([]string{"requested_model", "selected_model", "selected_provider", "policy_api_key_id", "complexity", "risk", "health_score", "fallback_plan", "route_reason", "decision_reason", "would_rewrite"}, map[string]any{
		"requested_model": text, "selected_model": text, "selected_provider": text, "policy_api_key_id": text,
		"complexity": map[string]any{"type": "object", "additionalProperties": true}, "risk": map[string]any{"type": "object", "additionalProperties": true},
		"health_score": integer, "fallback_plan": map[string]any{"type": "array", "items": text}, "route_reason": text, "decision_reason": text, "would_rewrite": flag,
	})
	return map[string]any{
		"RoutingDraftPatch":           patch,
		"RoutingDraftPreviewRequest":  object([]string{"rule_edit", "request"}, map[string]any{"rule_edit": object([]string{"id", "expected_revision", "patch"}, map[string]any{"id": map[string]any{"type": "string", "minLength": 1, "maxLength": 512}, "expected_revision": revision, "patch": schemaRef("RoutingDraftPatch")}), "request": request}),
		"RoutingDraftPlan":            plan,
		"RoutingDraftPreviewResponse": object([]string{"stage", "revision", "runtime_consistency", "observed_at", "before", "after"}, map[string]any{"stage": map[string]any{"type": "string", "enum": []string{"routing_plan"}}, "revision": revision, "runtime_consistency": map[string]any{"type": "string", "enum": []string{"sequential_live_reads"}}, "observed_at": map[string]any{"type": "string", "format": "date-time"}, "before": schemaRef("RoutingDraftPlan"), "after": schemaRef("RoutingDraftPlan")}),
		"RoutingDraftWriteRequest":    object([]string{"expected_revision", "patch", "reason"}, map[string]any{"expected_revision": revision, "patch": schemaRef("RoutingDraftPatch"), "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 500}}),
		"RoutingDraftWriteResponse":   object([]string{"rule", "revision"}, map[string]any{"rule": schemaRef("RoutingRuleView"), "revision": revision}),
		"RoutingRuleEditRequest":      map[string]any{"anyOf": []any{schemaRef("RoutingRulePatchRequest"), schemaRef("RoutingDraftWriteRequest")}, "description": "review=edit requires RoutingDraftWriteRequest. Without review, preserve the nullable legacy partial PATCH contract."},
		"RoutingRuleEditResponse":     map[string]any{"oneOf": []any{schemaRef("RoutingRuleWriteResponse"), schemaRef("RoutingDraftWriteResponse")}},
	}
}
