package proxy

func enrichMeKeyRotationOpenAPI(method string, op, responses map[string]any) {
	if method == "get" {
		responses["200"] = successResponse("MeKeyCatalog")
		return
	}
	op["requestBody"] = map[string]any{"required": false, "content": jsonContent(schemaRef("MeKeyRotationRequest"))}
	op["description"] = "Rotates only an active, unexpired key owned by the caller and within their current role, team and scopes. Preserves the original key restrictions and replacement expiry. All keys in a rotation lineage share key-scoped daily/monthly quota rules, committed usage and in-flight reservations; rotation does not reset the allowance. Individual request history remains attributed to each key. Omitted body or {} uses legacy immediate revocation. Supplying grace_seconds or expected_revision requires both a reason and a revision from GET /me/keys. Grace is capped by original expiry, at most 86400 seconds. Replacement, durable retirement lineage and both lifecycle audit events commit atomically. Duplicate rotation conflicts even during grace or after audit retention. A lost response cannot recover the one-time secret: inspect current keys and revoke an unusable replacement rather than automatically retrying."
	responses["200"] = successResponse("MeKeyRotationResult")
	for code, description := range map[string]string{"400": "Invalid review, reason or grace period", "401": "Authentication required", "403": "Current authority does not permit this rotation", "404": "Key not owned by caller or self-service disabled", "409": "Key changed, expired, inactive or already rotated", "500": "Rotation not confirmed; inspect current keys before any further action", "503": "Current team authority could not be verified"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func meKeyRotationOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	strings := map[string]any{"type": "array", "items": text}
	properties := map[string]any{}
	required := []string{"id", "name", "owner", "team", "user_id", "service_account_id", "role", "status", "expires_at", "revoked_at", "created_at", "revision"}
	for _, name := range required {
		properties[name] = text
	}
	for _, name := range []string{"scopes", "allowed_ips", "allowed_models", "denied_models", "allowed_providers", "denied_providers"} {
		properties[name] = strings
		required = append(required, name)
	}
	properties["budget_limit_krw"] = map[string]any{"type": "number", "description": "Existing per-request estimated cost ceiling. This is not a cumulative usage balance."}
	required = append(required, "budget_limit_krw")
	properties["revision"] = map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "Opaque reviewed-snapshot token, not a credential."}
	properties["replaced_by"] = map[string]any{"type": "string", "description": "Replacement ID; presence means this key cannot be rotated or scope-edited again."}
	properties["grace_ends_at"] = map[string]any{"type": "string", "format": "date-time", "description": "Immutable previous-key deadline, including immediate retirement. Authentication cannot extend it via ordinary key metadata edits."}
	return map[string]any{
		"MeKeyPublic": map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties},
		"MeKeyCatalog": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"api_keys", "role", "grantable_scopes"}, "properties": map[string]any{
			"api_keys": map[string]any{"type": "array", "items": schemaRef("MeKeyPublic")}, "role": text, "grantable_scopes": strings,
		}},
		"MeKeyRotationRequest": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
			"reason":            map[string]any{"type": "string", "minLength": 1, "maxLength": 1024, "description": "Nonblank trimmed audit reason. Required with a revision or grace period. Total body limit 8192 bytes; duplicate and unknown fields rejected."},
			"expected_revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "Exact revision from the reviewed catalog; requires reason."},
			"grace_seconds":     map[string]any{"type": "integer", "minimum": 0, "maximum": 86400, "default": 0, "description": "Requires reason and expected_revision, including zero. Actual grace cannot extend original expiry."},
		}},
		"MeKeyRotationResult": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"rotated_from", "grace_ends_at", "api_key", "secret"}, "properties": map[string]any{
			"rotated_from": text, "grace_ends_at": map[string]any{"type": "string", "format": "date-time"},
			"secret": map[string]any{"type": "string", "minLength": 1, "description": "One-time plaintext credential. Never log, persist in browser storage or send to telemetry."},
			"api_key": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "name", "user_id", "role", "scopes", "status"}, "properties": map[string]any{
				"id": text, "name": text, "user_id": text, "role": text, "scopes": strings, "status": text,
			}},
		}},
	}
}
