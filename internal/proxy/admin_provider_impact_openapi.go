package proxy

func providerImpactOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string", "maxLength": 1024}
	boolean := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": providerImpactReadLimit, "nullable": true}
	scannedCount := map[string]any{"type": "integer", "minimum": 0, "maximum": providerImpactReadLimit, "nullable": true,
		"description": "Configuration records considered within the bounded scan. For teams this is the number of eligible-key team identity entries considered (including repeated and unassigned entries), not the size of the team inventory."}
	ref := map[string]any{"type": "string", "pattern": `^prv_[A-Za-z0-9_-]{43}$`}
	return map[string]any{
		"ProviderImpactItem": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"reference", "label", "enabled"},
			"properties": map[string]any{
				"reference": map[string]any{"type": "string", "pattern": `^(impact_|prv_)[A-Za-z0-9_-]{43}$`},
				"label":     text, "enabled": boolean, "model": text, "provider_ref": ref,
				"relation": map[string]any{"type": "string", "enum": []string{"direct_binding", "configured_failover_group"}},
			},
		},
		"ProviderImpactSection": map[string]any{
			"type": "object", "additionalProperties": false,
			"description": "Complete means complete only within the stated configuration scope, not full runtime impact. Partial counts are confirmed lower bounds. Denied/unavailable counts are null, never zero. Items contain only safe labels and non-reversible references.",
			"required":    []string{"status", "scope", "reason", "count_kind", "scanned_count", "matched_count", "truncated", "items"},
			"properties": map[string]any{
				"status":        map[string]any{"type": "string", "enum": []string{"complete", "partial", "denied", "unavailable"}},
				"scope":         map[string]any{"type": "string", "enum": []string{"direct_provider_references", "configured_failover_group", "eligible_provider_access_configuration", "teams_of_eligible_key_configuration"}},
				"reason":        map[string]any{"type": "string", "enum": []string{"", "bounded_or_unassessable_configuration", "routing_read_required", "configuration_read_failed", "target_configuration_unassessable", "team_scoped_assessment_not_available", "key_configuration_unavailable", "team_configuration_read_failed"}},
				"count_kind":    map[string]any{"type": "string", "enum": []string{"exact", "lower_bound", "unknown"}},
				"scanned_count": scannedCount, "matched_count": count, "truncated": boolean,
				"items": map[string]any{"type": "array", "maxItems": providerImpactReadLimit, "items": schemaRef("ProviderImpactItem")},
			},
		},
		"ProviderImpactResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"provider_ref", "provider_display", "generated_at", "consistency", "is_default", "bootstrap_on_restart", "read_only", "upstream_calls", "concurrent_change_guard", "not_assessed", "routing_rules", "agent_routes", "failover_peers", "api_keys", "teams"},
			"properties": map[string]any{
				"provider_ref": ref, "provider_display": text,
				"generated_at": map[string]any{"type": "string", "format": "date-time"},
				"consistency":  map[string]any{"type": "string", "enum": []string{"best_effort"}},
				"is_default":   boolean, "bootstrap_on_restart": boolean,
				"read_only":               map[string]any{"type": "boolean", "enum": []bool{true}},
				"upstream_calls":          map[string]any{"type": "boolean", "enum": []bool{false}},
				"concurrent_change_guard": map[string]any{"type": "boolean", "enum": []bool{false}},
				"not_assessed":            map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": []string{"pattern_overlap", "full_model_catalog", "model_usage", "runtime_call_success", "ip_and_model_authorization", "concurrent_change_guard"}}},
				"routing_rules":           schemaRef("ProviderImpactSection"), "agent_routes": schemaRef("ProviderImpactSection"),
				"failover_peers": schemaRef("ProviderImpactSection"), "api_keys": schemaRef("ProviderImpactSection"), "teams": schemaRef("ProviderImpactSection"),
			},
		},
	}
}
