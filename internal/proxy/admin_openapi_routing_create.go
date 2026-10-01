package proxy

func enrichRoutingCreateOpenAPI(op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	op["description"] = "Create a routing rule with existing routing:write authorization; reading the collection separately requires routing:read. HTTP 201 returns the normalized handler copy with all ten fields, including created_at=0001-01-01T00:00:00Z. The store fills creation time in its own value copy, so a later GET returns the stored time instead; the POST timestamp is not a revision or proof of a stored-row snapshot. Normally repeated requests generate different IDs and can create duplicate configurations; there is no revision/CAS or idempotency token. Existing ID generation and upsert behavior do not guarantee collision-free insertion. Local routing cache invalidation and best-effort audit follow persistence; other processes retain the existing five-second cache TTL. Configured post-change checks may run and record state. Audit/post-change work is not an atomic transaction with the rule. Response loss may occur after persistence and is not evidence that retransmission is safe. Unknown fields, case-insensitive aliases and the existing single Go JSON decode behavior are preserved. This raw configuration response is not a masked projection, provider/model validation, or proof of the effect on live traffic."
	op["requestBody"] = requestBody("RoutingRuleCreateRequest")
	responses["201"] = successResponse("RoutingRuleWriteResponse")
	responses["400"] = errorResponse("invalid_body for JSON/type/integer decoding failures; missing_target_model when the decoded target is blank after Go whitespace trimming; invalid_range unless 0 <= min <= max <= 100. A null body decodes but fails target validation.")
	responses["401"] = errorResponse("Existing authentication/scope rejection: invalid_api_key. POST requires routing:write; legacy read-only credentials cannot create. GET separately requires routing:read.")
	responses["500"] = errorResponse("routing_rule_save_failed: persistence failed. Lost or otherwise unconfirmed responses are not proof that a rule was not applied.")
}

func routingCreateOpenAPISchemas() map[string]any {
	text := func(description string) map[string]any {
		return map[string]any{"type": "string", "nullable": true, "description": description}
	}
	integer := func(description string) map[string]any {
		return map[string]any{"type": "integer", "format": "int64", "nullable": true, "description": description}
	}
	return map[string]any{
		"RoutingRuleCreateRequest": map[string]any{
			"type": "object", "additionalProperties": true,
			"description": "Eight known optional/nullable fields describe the existing Go decoder input; after decoding, target_model must be nonblank. Canonical required keys are not imposed because existing case-insensitive aliases remain accepted. Absent fields or fields supplied only as null begin with Go zero values, except enabled defaults to true; these are create defaults, not preservation of an existing row. ID and created_at are server-assigned and unknown input fields are ignored. No new string-length limit, provider/model existence check or strict JSON parser is introduced.",
			"properties": map[string]any{
				"enabled":         map[string]any{"type": "boolean", "nullable": true, "description": "Omitted/null defaults to true; explicit false creates a disabled rule."},
				"priority":        integer("Omitted/null/zero/negative values become 100; positive integers are preserved. This differs from PATCH."),
				"match_pattern":   text("Surrounding Go whitespace is trimmed; omitted/null/blank becomes * (all models)."),
				"min_complexity":  integer("Omitted/null defaults to zero; decoded bounds must satisfy 0 <= min <= max <= 100 together."),
				"max_complexity":  integer("Omitted/null defaults to zero; decoded bounds must satisfy 0 <= min <= max <= 100 together."),
				"target_model":    text("Surrounding Go whitespace is trimmed; omitted/null/blank fails with missing_target_model."),
				"target_provider": text("Surrounding Go whitespace is trimmed; omitted/null/blank becomes an empty configured provider."),
				"note":            text("Surrounding Go whitespace is trimmed; omitted/null/blank becomes an empty note."),
			},
		},
	}
}
