package proxy

func redTeamPreflightOpenAPISchema() map[string]any {
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": 9007199254740991}
	amount := map[string]any{"type": "number", "minimum": 0}
	properties := map[string]any{
		"campaign_id":        map[string]any{"type": "string", "minLength": 1},
		"note":               map[string]any{"type": "string"},
		"estimated_cost_krw": amount,
		"limits": map[string]any{"type": "object", "required": []string{"budget_limit_krw", "qps_limit", "concurrency", "timeout_ms"}, "properties": map[string]any{
			"budget_limit_krw": amount, "qps_limit": amount, "concurrency": count, "timeout_ms": count,
		}},
	}
	required := []string{"campaign_id", "note", "estimated_cost_krw", "limits"}
	for _, name := range []string{"targets", "probe_packs", "case_executions", "external_targets", "destructive_tool_targets", "active_eligible_targets", "models_selected"} {
		properties[name] = count
		required = append(required, name)
	}
	for _, name := range []string{"requires_approval", "approved", "can_run"} {
		properties[name] = map[string]any{"type": "boolean"}
		required = append(required, name)
	}
	return map[string]any{"type": "object", "required": required, "properties": properties}
}
