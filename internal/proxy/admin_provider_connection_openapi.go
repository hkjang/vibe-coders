package proxy

func providerConnectionOpenAPISchemas() map[string]any {
	return map[string]any{
		"ProviderConnectionTestRequest": map[string]any{
			"type": "object", "additionalProperties": false,
			"required":    []string{"base_url", "credential_mode"},
			"description": "Exactly one of name (new target) or provider_ref (existing target) is required. Unknown, duplicate, case-variant, null and trailing fields are rejected; body limit 32768 bytes. New names are checked for an existing provider but this is not a later-save precondition or CAS. Stored credentials are read at request time and only sent to the current validated stored URL when the submitted URL matches. Unsafe or masked legacy URLs cannot use stored credentials. No provider configuration or model cache is changed; a bounded result-only action audit is recorded.",
			"oneOf": []any{
				map[string]any{"required": []string{"name"}, "not": map[string]any{"required": []string{"provider_ref"}}},
				map[string]any{"required": []string{"provider_ref"}, "not": map[string]any{"required": []string{"name"}}},
			},
			"properties": map[string]any{
				"name":            map[string]any{"type": "string", "minLength": 1, "maxLength": maxModelsProviderNameBytes, "description": "New provider name, subject to existing creation validation. An existing name returns 409 without using its key."},
				"provider_ref":    map[string]any{"type": "string", "pattern": `^prv_[A-Za-z0-9_-]{43}$`},
				"base_url":        map[string]any{"type": "string", "minLength": 1, "maxLength": 8192, "description": "HTTP(S) base URL, at most 8192 UTF-8 bytes, without credentials. Input uses existing save normalization: surrounding whitespace and trailing slashes of the full string are removed. Existing fixed base-path/query semantics apply; /v1/models is appended without smart path de-duplication. Stored mode rejects normalization that would change the actual stored destination."},
				"credential_mode": map[string]any{"type": "string", "enum": []string{"draft", "stored", "none"}, "description": "draft requires api_key; stored requires provider_ref and forbids api_key; none forbids api_key and is rejected when the existing provider has a stored key. none omits the Authorization header."},
				"api_key":         map[string]any{"type": "string", "minLength": 1, "maxLength": 8192, "writeOnly": true, "description": "Draft-only credential, at most 8192 UTF-8 bytes; not returned, audited or stored. Internal whitespace/control characters are rejected."},
				"timeout_ms":      map[string]any{"type": "integer", "minimum": 0, "maximum": 600000, "description": "0 or omitted uses the configured upstream timeout. Effective probe timeout is clamped to 1–10000 ms and includes queue/DB/network time; the entire ingress/probe is also bounded by a 10-second parent context. Audit has a separate at-most-1-second budget."},
			},
		},
		"ProviderConnectionTestResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required":    []string{"outcome", "upstream_status", "duration_ms", "timeout_ms", "model_count"},
			"description": "Fresh fixed GET /v1/models only: success requires 2xx and one lowercase data array whose object entries each contain one nonblank string id. Empty arrays are valid. This does not prove inference support, model access, billing or a later save. No raw provider/model/error/header/credential data is returned. The bounded model catalogue is never cached by this operation. All upstream failures, including 401/403, use HTTP 200 with an outcome; HTTP 401 is reserved for gateway authentication.",
			"properties": map[string]any{
				"outcome":         map[string]any{"type": "string", "enum": []string{"catalog_available", "authentication_rejected", "redirect_blocked", "upstream_rejected", "invalid_response", "response_too_large", "model_limit_exceeded", "timeout", "connection_failed", "cancelled"}},
				"upstream_status": map[string]any{"type": "integer", "minimum": 100, "maximum": 599, "nullable": true, "description": "Null when no valid upstream HTTP status was received. No upstream headers or body are reflected."},
				"duration_ms":     map[string]any{"type": "integer", "minimum": 0, "description": "Observed queue/validation/network elapsed time, excluding the action audit."},
				"timeout_ms":      map[string]any{"type": "integer", "minimum": 1, "maximum": 10000},
				"model_count":     map[string]any{"type": "integer", "minimum": 0, "maximum": maxModelsPerProvider, "nullable": true, "description": "Returned catalogue entry count only on catalog_available (including zero); null for every failure. Not an inference-validated or distinct-model count."},
			},
		},
	}
}
