package proxy

import "strings"

func enrichCostGuardOpenAPIOperation(method string, op, responses map[string]any) {
	appError := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["200"] = successResponse("CostGuardConfigResponse")
	responses["401"] = appError("invalid_api_key: admin read scope is required for GET; admin write scope is required for POST")
	responses["503"] = appError("cost_guard_config_unavailable: no confirmed valid configuration snapshot; no POST changes committed")
	if strings.EqualFold(method, "get") {
		op["description"] = "Returns one uncached persisted flag snapshot. Missing flags default to false and zero; database failures or malformed stored flags return 503, not defaults. This is not confirmation of activation across pods."
		return
	}
	op["description"] = "Atomically updates only supplied non-null fields and returns the validated snapshot from that committed transaction, without a follow-up read. Omission or null preserves a field; false and zero are explicit values. An empty object or null body is a no-op. Malformed retained flags reject the entire update; replacing all malformed flags with valid values can repair configuration. No optimistic concurrency version is provided. Runtime caches on other pods retain their existing TTL."
	op["requestBody"] = requestBody("CostGuardConfigRequest")
	responses["400"] = appError("invalid_body or invalid_threshold: invalid input; no fields changed")
	responses["500"] = appError("cost_guard_save_failed: atomic storage failed; no success snapshot returned")
}

func costGuardOpenAPISchemas() map[string]any {
	return map[string]any{
		"CostGuardConfigResponse": map[string]any{
			"type": "object", "required": []string{"enabled", "threshold_krw"},
			"properties": map[string]any{
				"enabled":       map[string]any{"type": "boolean"},
				"threshold_krw": map[string]any{"type": "number", "minimum": 0, "description": "Finite nonnegative KRW threshold. Zero disables the global gate even when enabled is true."},
			},
		},
		"CostGuardConfigRequest": map[string]any{
			"type": "object", "nullable": true, "description": "Optional fields; an empty object or null body preserves the existing configuration.",
			"properties": map[string]any{
				"enabled":       map[string]any{"type": "boolean", "nullable": true, "description": "Omit or null to retain the stored flag; false explicitly disables it."},
				"threshold_krw": map[string]any{"type": "number", "minimum": 0, "nullable": true, "description": "Finite nonnegative decimal. Omit or null to retain the stored threshold; zero explicitly disables the global gate."},
			},
		},
	}
}
