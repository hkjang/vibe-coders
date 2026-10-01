package proxy

func enrichRoutingDeleteOpenAPI(op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	op["description"] = "Delete the requested rule ID with existing routing:write authorization; the separate collection GET requires routing:read. Legacy read-only credentials cannot DELETE. The SQL DELETE does not check an affected-row count: success also applies when the ID was already absent or a previous DELETE removed it. The acknowledgment echoes the decoded request-path ID and status deleted, not a deleted-row snapshot or proof of prior existence. No request body is required or interpreted. There is no revision/CAS, expected-state comparison or idempotency token. A preflight GET cannot lock the rule, and a rule concurrently recreated with the same ID can be deleted or appear after this response. Every successful DELETE, including repeated or absent-ID requests, invalidates this process's routing cache and attempts best-effort audit; configured post-change checks may run and record state. These effects are not atomic with the deletion; other processes retain the existing five-second cache TTL. Response loss may occur after deletion. A subsequent GET observes current configuration, not which request removed a row or whether replay is appropriate."
	responses["200"] = successResponse("RoutingRuleDeleteResponse")
	responses["400"] = errorResponse("invalid_rule_id: the decoded ID is empty or contains a slash.")
	responses["401"] = errorResponse("invalid_api_key: existing authentication or routing:write scope rejection, including legacy read-only credentials. Admin role names or admin:write alone do not grant routing:write.")
	responses["500"] = errorResponse("routing_rule_delete_failed: the SQL DELETE returned an error. An absent row alone is not an error; no rule_not_found 404 is generated. A lost or unconfirmed response must not be treated as proof that no change occurred.")
}

func routingDeleteOpenAPISchemas() map[string]any {
	return map[string]any{
		"RoutingRuleDeleteResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"id", "status"},
			"properties": map[string]any{
				"id":     map[string]any{"type": "string", "description": "Exact decoded request-path ID, not evidence that a row existed or a revision token."},
				"status": map[string]any{"type": "string", "enum": []string{"deleted"}, "description": "Acknowledges a successful SQL DELETE even when zero rows matched."},
			},
		},
	}
}
