package proxy

func enrichAdminKeyRevokeOpenAPI(method string, op, responses map[string]any) {
	if method == "get" {
		responses["200"] = successResponse("AdminKeyCatalog")
		return
	}
	op["requestBody"] = map[string]any{"required": false, "content": jsonContent(schemaRef("AdminKeyRevokeRequest"))}
	parameters, _ := op["parameters"].([]any)
	op["parameters"] = append(parameters, map[string]any{
		"name": "hard", "in": "query", "required": false,
		"schema":      map[string]any{"type": "integer", "enum": []int{0, 1}, "default": 0},
		"description": "1 deletes only the key registration row; otherwise revoke. Requires super_admin when authentication is enabled. Request, audit and rotation history are retained.",
	})
	op["description"] = "Revokes a key, or deletes only its registration row with hard=1 (super_admin only with authentication enabled). Existing request history, audit and rotation lineage are retained. Omitted body, JSON null or {} preserves legacy calls. Any supplied review requires both a nonblank reason and the exact revision from GET /admin/api-keys. The authorized snapshot is compared at write time; key change, admin audit and lifecycle audit commit atomically. Stale reviews conflict. Lost responses must be reconciled using current keys and audit, not automatically retried. Revoke review support is advertised by the responding catalog server; mixed-version deployments must upgrade all pods before using the reviewed operation."
	for code, description := range map[string]string{"400": "Invalid review body", "401": "Authentication required", "403": "Insufficient role, scope or team authority", "404": "Key not found", "409": "Key changed since review or authorization", "500": "Change not confirmed; inspect current keys and audit", "503": "Review authority unavailable"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["200"] = map[string]any{"description": "Key revoked or registration deleted", "content": jsonContent(map[string]any{"type": "object", "required": []string{"id", "status"}, "properties": map[string]any{"id": map[string]any{"type": "string"}, "status": map[string]any{"type": "string", "enum": []string{"revoked", "deleted"}}}})}
}
func adminKeyRevokeOpenAPISchemas() map[string]any {
	return map[string]any{
		"AdminKeyCatalog": map[string]any{"type": "object", "required": []string{"api_keys", "revoke_review_supported"}, "properties": map[string]any{
			"api_keys": map[string]any{"type": "array", "items": schemaRef("MeKeyPublic")}, "revoke_review_supported": map[string]any{"type": "boolean"},
		}},
		"AdminKeyRevokeRequest": map[string]any{"oneOf": []any{
			map[string]any{"type": "object", "nullable": true, "additionalProperties": false, "maxProperties": 0, "description": "Legacy empty object or JSON null; the whole body may also be omitted."},
			map[string]any{"type": "object", "additionalProperties": false, "required": []string{"reason", "expected_revision"}, "properties": map[string]any{
				"reason":            map[string]any{"type": "string", "minLength": 1, "maxLength": 1024, "description": "Trimmed nonblank audit reason; must be paired with expected_revision. Body limit8192bytes; duplicates, nulls and unknown fields rejected."},
				"expected_revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "Exact reviewed catalog revision; must be paired with reason."},
			}},
		}},
	}
}
