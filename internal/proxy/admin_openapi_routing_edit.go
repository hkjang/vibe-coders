package proxy

func enrichRoutingEditOpenAPI(method string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["401"] = errorResponse("Existing authentication/scope rejection: invalid_api_key. GET requires routing:read; PATCH requires routing:write. Legacy read-only credentials cannot PATCH.")
	if method == "get" {
		op["description"] = "Read stored routing rules with existing routing:read authorization. The unpaginated list includes all ten raw configuration fields for every row and uses [] when empty. This is configuration, not a masked projection, a revision token, or proof that the rule currently selects live traffic."
		responses["200"] = successResponse("RoutingRuleListResponse")
		responses["500"] = errorResponse("routing_rules_failed: stored list could not be read.")
		return
	}
	op["description"] = "Partially update an existing rule with routing:write authorization. Omitted or null fields retain their database values at the actual UPDATE, not an earlier handler snapshot. The rule is never inserted by PATCH. Complexity bounds are validated together against the values at that write. Success returns the row from UPDATE RETURNING, not a later reread. Explicit concurrent writes to the same field remain last-writer-wins; there is no revision/CAS or idempotency token. Local routing cache invalidation and best-effort audit follow a successful update; other processes retain the existing five-second cache TTL. Configured post-change checks may run and record state. Response loss may occur after the write, so an unconfirmed response is not evidence that it is safe to reapply. Empty object or null body is a no-op update of an existing valid rule. Unknown fields, case-insensitive field aliases and the existing Go JSON decoder behavior are preserved."
	op["requestBody"] = requestBody("RoutingRulePatchRequest")
	responses["200"] = successResponse("RoutingRuleWriteResponse")
	responses["400"] = errorResponse("invalid_rule_id, invalid_body, invalid_priority, missing_target_model or invalid_range. After a no-row UPDATE, existence is diagnosed by a separate current read; concurrent changes can affect that diagnosis.")
	responses["404"] = errorResponse("rule_not_found: rule absent at initial lookup or no-row UPDATE diagnosis; PATCH never recreates it.")
	responses["500"] = errorResponse("routing_rule_lookup_failed or routing_rule_save_failed: lookup, UPDATE or returned-row processing failed. A client must not infer non-application solely from a lost or unconfirmed response.")
}

func routingEditOpenAPISchemas() map[string]any {
	text := func(description string) map[string]any {
		return map[string]any{"type": "string", "nullable": true, "description": description}
	}
	integer := func(description string) map[string]any {
		return map[string]any{"type": "integer", "format": "int64", "nullable": true, "description": description}
	}
	fields := map[string]any{
		"id": map[string]any{"type": "string"}, "enabled": map[string]any{"type": "boolean"},
		"priority": map[string]any{"type": "integer", "format": "int64"}, "match_pattern": map[string]any{"type": "string"},
		"min_complexity": map[string]any{"type": "integer", "format": "int64"}, "max_complexity": map[string]any{"type": "integer", "format": "int64"},
		"target_model": map[string]any{"type": "string"}, "target_provider": map[string]any{"type": "string"}, "note": map[string]any{"type": "string"},
		"created_at": map[string]any{"type": "string", "format": "date-time", "description": "Original creation timestamp, not a modification revision. Invalid legacy stored times decode to the Go zero timestamp."},
	}
	return map[string]any{
		"RoutingRuleView": map[string]any{
			"type": "object", "additionalProperties": false,
			"required":   []string{"id", "enabled", "priority", "match_pattern", "min_complexity", "max_complexity", "target_model", "target_provider", "note", "created_at"},
			"properties": fields,
		},
		"RoutingRuleListResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"rules"},
			"properties": map[string]any{"rules": map[string]any{"type": "array", "items": schemaRef("RoutingRuleView")}},
		},
		"RoutingRuleWriteResponse": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"rule"},
			"properties": map[string]any{"rule": schemaRef("RoutingRuleView")},
		},
		"RoutingRulePatchRequest": map[string]any{
			"type": "object", "nullable": true, "additionalProperties": true,
			"description": "Every known field is optional and nullable: omitted/null preserves the database column at UPDATE time. Non-null false, zero and empty strings are explicit inputs, subject to field normalization and merged validation. ID and created_at are not editable. No new string-length cap or strict JSON parser is introduced.",
			"properties": map[string]any{
				"enabled":         map[string]any{"type": "boolean", "nullable": true},
				"priority":        integer("Explicit values must be positive; unlike create, zero is rejected, not defaulted."),
				"match_pattern":   text("Surrounding Go whitespace is trimmed; an explicit empty value becomes * (all models)."),
				"min_complexity":  integer("Zero is explicit; merged bounds must satisfy 0 <= min <= max <= 100 at the write."),
				"max_complexity":  integer("Zero is explicit; merged bounds must satisfy 0 <= min <= max <= 100 at the write."),
				"target_model":    text("Surrounding Go whitespace is trimmed; an explicit blank value is rejected."),
				"target_provider": text("Surrounding Go whitespace is trimmed; an explicit empty value clears the configured provider."),
				"note":            text("Surrounding Go whitespace is trimmed; an explicit empty value clears the note."),
			},
		},
	}
}
