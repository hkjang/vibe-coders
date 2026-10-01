package proxy

import "vibe-coders/internal/store"

func enrichPolicyImportOpenAPI(route string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["401"] = errorResponse("Existing authentication/scope rejection: invalid_api_key. Legacy readonly credentials allow export GET but not import POST, including dry-run.")
	if route == "/admin/policies/export" {
		op["description"] = "Export raw policy configuration with existing security:read authorization. One LEFT JOIN statement snapshot reads policies and their rules together; every policy includes rules, including an empty array. Local JSON-number decoding preserves stored finite number tokens without JavaScript conversion, but this is not byte-exact file backup or whole-database recovery. Raw names, conditions and actions are not a masked UI projection. Later import has no server CAS or concurrency reservation; reapplying this document does not remove policies absent from the file."
		responses["200"] = successResponse("PolicyExportResponse")
		responses["500"] = errorResponse("Export/query or stored JSON decoding failed: policies_failed. No raw SQL/JSON error is echoed.")
		return
	}
	op["description"] = "Import typed policy configuration with existing admin:write authorization, including dry-run. Validate/normalize the whole batch before any policy write; apply all policy/rule changes in one database transaction and invalidate this store's policy cache once after commit. Caches in other processes retain the existing TTL. This is no server CAS, idempotency token or whole-database restore. Missing or nil/null rules preserve existing rules; explicit [] clears them. Existing rule IDs may move between policies explicitly replacing their rules in this batch, not from a policy preserving its rules. Audit is count-only best-effort after commit and configured follow-up dry-run checks may record additional state; neither is atomic with policy changes. Unknown typed fields are ignored, case-insensitive known-field aliases retain Go decoder compatibility, and duplicate decoded JSON object keys are rejected. Only the exact dry_run=1 value avoids writes."
	op["parameters"] = []any{map[string]any{
		"name": "dry_run", "in": "query", "required": false,
		"description": `Only exactly "1" requests validation/plan without policy writes. Omitted, "true", "0" and other values apply the batch. Dry-run still requires admin:write.`,
		"schema":      map[string]any{"type": "string", "example": "1"},
	}}
	op["requestBody"] = requestBody("PolicyImportRequest")
	responses["200"] = successResponse("PolicyImportResponse")
	responses["400"] = errorResponse("Fixed validation codes: invalid_body (UTF-8, JSON, exact duplicate keys, depth, trailing document or typed field error), empty_payload, policy_import_limit, invalid_policy, invalid_policy_rule, duplicate_policy_id, duplicate_rule_id, policy_rule_conflict. No policy writes occur for these validation failures.")
	responses["405"] = errorResponse("Import requires POST: method_not_allowed.")
	responses["413"] = errorResponse("JSON body exceeds 4194304 UTF-8 bytes: policy_import_too_large.")
	responses["500"] = errorResponse("Database import failed: policy_import_failed. Policy/rule writes roll back together on transaction failure; response loss after commit can still leave the client unsure whether application succeeded.")
}

func policyImportOpenAPISchemas() map[string]any {
	text := func(nullable bool, description string) map[string]any {
		return map[string]any{"type": "string", "nullable": nullable, "description": description}
	}
	integer := func(description string) map[string]any {
		return map[string]any{"type": "integer", "format": "int64", "nullable": true, "description": description}
	}
	timestamp := func(description string) map[string]any {
		return map[string]any{"type": "string", "format": "date-time", "nullable": true, "description": description}
	}
	ruleJSON := func() map[string]any {
		return map[string]any{"type": "object", "nullable": true, "additionalProperties": true,
			"description": "Opaque JSON object; omitted/null becomes {}. Unknown keys and nested values are preserved without the single-policy decoder's key normalization. Finite JSON number tokens are retained locally; numbers outside float64 range are rejected. Ordinary policy/runtime readers and JavaScript clients do not gain arbitrary-precision guarantees."}
	}
	inputPolicy := map[string]any{
		"id":              text(false, "Required nonblank ID. Surrounding whitespace is checked for emptiness but retained; duplicate policy IDs are rejected."),
		"name":            text(false, "Required nonblank name; checked for emptiness without trimming the stored value."),
		"description":     text(true, "Omitted/null replaces the description with an empty string."),
		"enabled":         map[string]any{"type": "boolean", "nullable": true, "description": "Omitted/null means false. Import may enable a policy when true; this is not a disabled-draft-only endpoint."},
		"priority":        integer("Omitted/null/0 becomes 100; negative integers are retained. Fractional numbers and numeric strings are rejected by typed decoding."),
		"rollout_percent": integer("Omitted/null, zero, negative or values above 100 become 100. This is normalization, not an input-range rejection."),
		"created_at":      timestamp("Omitted/null/zero uses server time for a new policy; an existing policy retains its original creation time."),
		"updated_at":      timestamp("Accepted for typed compatibility but replaced by server time."),
		"rules": map[string]any{"type": "array", "nullable": true, "maxItems": store.MaxPolicyImportRules, "items": schemaRef("PolicyImportRule"),
			"description": "Omitted/null preserves this policy's rules; [] explicitly removes all its rules. The total number of explicit rules across all policies may not exceed 10000."},
	}
	inputRule := map[string]any{
		"id":         text(false, "Required nonblank rule ID, unique across this batch and compatible with final rule ownership. Never auto-generated by typed import."),
		"policy_id":  text(true, "Omitted/null/empty is filled with the enclosing policy ID. Any other value must exactly match that ID."),
		"name":       text(true, "Omitted/null becomes empty. Nonempty strings retain their original whitespace."),
		"enabled":    map[string]any{"type": "boolean", "nullable": true, "description": "Omitted/null means false."},
		"priority":   integer("Omitted/null/0 becomes 100; negative integers are retained."),
		"conditions": ruleJSON(), "actions": ruleJSON(),
		"rollout_percent": integer("Legacy typed field accepted but not persisted on rules. Runtime enforcement reads the parent policy's rollout value."),
		"created_at":      timestamp("Omitted/null/zero uses server time; an explicit valid timestamp is retained when replacing the rule."),
		"updated_at":      timestamp("Accepted but replaced by server time."),
	}
	exportPolicy := map[string]any{
		"id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}, "description": map[string]any{"type": "string"},
		"enabled": map[string]any{"type": "boolean"}, "priority": map[string]any{"type": "integer", "format": "int64"}, "rollout_percent": map[string]any{"type": "integer", "format": "int64"},
		"created_at": map[string]any{"type": "string", "format": "date-time"}, "updated_at": map[string]any{"type": "string", "format": "date-time"},
		"rules": map[string]any{"type": "array", "items": schemaRef("PolicyExportRule"), "description": "Always present, including [] so reimport can clear rules added after this export."},
	}
	exportRule := map[string]any{
		"id": map[string]any{"type": "string"}, "policy_id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"},
		"enabled": map[string]any{"type": "boolean"}, "priority": map[string]any{"type": "integer", "format": "int64"},
		"conditions": map[string]any{"type": "object", "additionalProperties": true}, "actions": map[string]any{"type": "object", "additionalProperties": true},
		"created_at": map[string]any{"type": "string", "format": "date-time"}, "updated_at": map[string]any{"type": "string", "format": "date-time"},
	}
	return map[string]any{
		"PolicyImportRequest": map[string]any{
			"type": "object", "additionalProperties": true, "required": []string{"policies"},
			"x-body-max-bytes": policyImportMaxBody, "x-json-max-depth": policyImportMaxDepth, "x-total-rules-limit": store.MaxPolicyImportRules,
			"description": "One UTF-8 JSON document, at most 4194304 bytes and 64 nested object/array levels; exact duplicate decoded object keys and trailing content are rejected. policies has 1–1000 items and explicit rules total at most 10000. Canonical lowercase known fields are described here; the existing typed decoder also accepts case-insensitive aliases and ignores unknown fields, including export envelope version/count. No additional string-length cap or CAS field is introduced. This is the typed import contract, not the looser single-policy POST decoder.",
			"properties":  map[string]any{"policies": map[string]any{"type": "array", "minItems": 1, "maxItems": store.MaxPolicyImportPolicies, "items": schemaRef("PolicyImportPolicy")}},
		},
		"PolicyImportPolicy": map[string]any{"type": "object", "additionalProperties": true, "required": []string{"id", "name"}, "properties": inputPolicy},
		"PolicyImportRule":   map[string]any{"type": "object", "additionalProperties": true, "required": []string{"id"}, "properties": inputRule},
		"PolicyImportResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"dry_run", "created", "updated", "plan"},
			"properties": map[string]any{
				"dry_run": map[string]any{"type": "boolean"}, "created": map[string]any{"type": "integer", "minimum": 0}, "updated": map[string]any{"type": "integer", "minimum": 0},
				"plan": map[string]any{"type": "array", "maxItems": store.MaxPolicyImportPolicies, "items": schemaRef("PolicyImportPlanItem")},
			},
		},
		"PolicyImportPlanItem": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"id", "name", "action", "rules"},
			"properties": map[string]any{
				"id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}, "action": map[string]any{"type": "string", "enum": []string{"create", "update"}},
				"rules": map[string]any{"type": "integer", "minimum": 0, "maximum": store.MaxPolicyImportRules, "description": "Submitted explicit rule count, not the preserved rule count. Missing/null rules yields 0 in this plan while retaining existing rules."},
			},
		},
		"PolicyExportResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"version", "count", "policies"},
			"properties": map[string]any{"version": map[string]any{"type": "integer", "enum": []int{1}}, "count": map[string]any{"type": "integer", "minimum": 0}, "policies": map[string]any{"type": "array", "items": schemaRef("PolicyExportPolicy")}},
		},
		"PolicyExportPolicy": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "name", "description", "enabled", "priority", "rollout_percent", "created_at", "updated_at", "rules"}, "properties": exportPolicy},
		"PolicyExportRule":   map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "policy_id", "name", "enabled", "priority", "conditions", "actions", "created_at", "updated_at"}, "properties": exportRule},
	}
}
