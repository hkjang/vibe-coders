package proxy

func enrichRoutingOrderOpenAPI(method string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["400"] = errorResponse("invalid_routing_order: malformed, duplicate, unknown, missing or null fields, invalid complete permutation or query. New order operations require canonical fields and valid UTF-8 JSON, at most 512 KiB.")
	responses["401"] = errorResponse("Existing invalid_api_key authentication or routing scope rejection. Reading and comparison require routing:read; order writes require both routing:read and routing:write. Existing legacy readonly tokens permit GET but still reject POST preview.")
	responses["422"] = errorResponse("routing_order_limit: more than 1000 stored rules or a legacy identifier outside safe order bounds; no partial snapshot or mutation is returned.")
	responses["500"] = errorResponse("routing_order_failed: read, transaction or audit failed. An unconfirmed response is not evidence that a write was not applied; never automatically retry a mutation.")
	switch method {
	case "get":
		responses["400"] = errorResponse("invalid_routing_detail: malformed, duplicate or invalid exact ID, or an ID combined with other queries; invalid_routing_order: invalid or combined order-view query. Detail IDs are exact UTF-8 values of at most 512 code points and 2048 bytes, without control or format characters.")
		op["description"] = "Without view=order or id the existing complete raw routing rule list is unchanged. A single id query selects exactly that stored rule and returns the same raw configuration shape with zero or one row and no-store. Detail IDs are nonblank exact strings up to 512 Unicode characters and 2048 UTF-8 bytes without surrounding whitespace, control or format characters. Duplicate, malformed, empty IDs and mixed detail queries return 400; an invalid detail never falls back to the whole collection. This read requires routing:read and does not change or execute routing. Exactly view=order and no other query returns a bounded review snapshot in the existing server order (priority, then stored creation timestamp). Its SHA-256 revision compares all configuration fields; it is not a monotonic version or idempotency token. Equal priority and creation timestamp have unspecified legacy order, reported by ambiguous_ties. Order snapshots use no-store."
		op["parameters"] = []any{map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"order"}}}, map[string]any{"name": "id", "in": "query", "schema": map[string]any{"type": "string", "minLength": 1, "maxLength": 512}, "description": "Exact read-only rule ID, mutually exclusive with view and any other query."}}
		responses["200"] = successResponse("RoutingRuleReadResponse")
	case "patch":
		op["description"] = "Atomically reorder the complete 2..1000 rule set, including disabled rules, and record the operator, prior/new priorities and required reason in one audit transaction. Priorities become 1..N in the specified exact order; other fields remain unchanged. Under a database write lock the complete configuration revision is checked again, including concurrent ordinary create/update/delete. A conflict never partially applies. Local cache is invalidated after commit; other processes retain the existing five-second TTL. Configured post-change checks run after commit. No query is accepted. Lost responses are not safe to retry automatically."
		op["requestBody"] = requestBody("RoutingOrderRequest")
		responses["200"] = successResponse("RoutingOrderSnapshot")
		responses["409"] = errorResponse("routing_order_conflict: reviewed configuration differs from current configuration; reload and review again.")
	case "post":
		op["description"] = "Existing ordinary routing preview is preserved. Presence of rule_order or rule_revision selects strict order comparison: exactly model, complexity, rule_order, rule_revision, with no query. This read-only comparison reuses the live first-match complexity-rule evaluator, including disabled and no-op semantics, and compares only that stage. It does not execute model calls or simulate policy, user/team routing, learning, provider health or failover. ambiguous_before_order warns when the legacy baseline ties are unspecified. It does not mutate rules, cache or audit. Existing raw-read redaction applies."
		op["requestBody"] = requestBody("RoutingPreviewRequest")
		op["description"] = op["description"].(string) + " Presence of rule_edit selects RoutingDraftPreviewRequest instead. It compares an immutable saved rule set and an unsaved seven-field edit with the same full intelligent-routing planner used by real unpinned requests. Automatic model selection bypasses the complexity rule stage. Key scope is fixed once; provider health, learning and provider configuration remain sequential live reads, explicitly indicated by runtime_consistency. No model/tool call or mutation occurs; results are plans, not measured whole-traffic impact. Stored rule revision is checked again after both plans; ambiguous precedence is rejected. The supported trial request is text messages without tools or client pin/no-route headers."
		responses["200"] = successResponse("RoutingPreviewResponse")
		responses["400"] = errorResponse("invalid_routing_order or invalid_routing_draft: malformed, duplicate, unknown, missing or null canonical fields, invalid trial or patch, unexpected query, or additional 512 KiB comparison limit exceeded.")
		responses["404"] = errorResponse("routing_rule_not_found: the rule being reviewed no longer exists.")
		responses["409"] = errorResponse("routing_order_conflict or routing_draft_conflict: reviewed configuration changed; no comparison result is returned.")
		responses["422"] = errorResponse("routing_order_limit, routing_draft_limit or routing_draft_ambiguous: the bounded rule set cannot be safely compared; no partial result is returned.")
		responses["500"] = errorResponse("routing_order_failed or routing_draft_failed: comparison or revision verification failed.")
		responses["413"] = errorResponse("body_too_large: existing preview request exceeds 4 MiB; order and draft comparisons have an additional 512 KiB limit reported as 400.")
	}
}

func routingOrderOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	revision := map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	order := map[string]any{"type": "array", "minItems": 2, "maxItems": 1000, "uniqueItems": true, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 512, "description": "Exact stored ID, at most 2048 UTF-8 bytes, without Unicode control or format characters."}}
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	legacyRequest := map[string]any{"type": "object", "additionalProperties": true, "not": map[string]any{"anyOf": []any{map[string]any{"required": []string{"rule_order"}}, map[string]any{"required": []string{"rule_revision"}}, map[string]any{"required": []string{"rule_edit"}}}}}
	legacyResponse := map[string]any{"type": "object", "additionalProperties": true, "not": map[string]any{"required": []string{"stage"}}, "description": "Existing ordinary intelligent routing preview response, unchanged."}
	return map[string]any{
		"RoutingRuleReadResponse":     map[string]any{"oneOf": []any{schemaRef("RoutingRuleListResponse"), schemaRef("RoutingOrderSnapshot")}},
		"RoutingOrderSnapshot":        object([]string{"rules", "revision", "ambiguous_ties"}, map[string]any{"rules": map[string]any{"type": "array", "maxItems": 1000, "items": schemaRef("RoutingRuleView")}, "revision": revision, "ambiguous_ties": flag}),
		"RoutingOrderRequest":         object([]string{"order", "expected_revision", "reason"}, map[string]any{"order": order, "expected_revision": revision, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 500, "description": "Required nonblank reason, trimmed before auditing; limit is Unicode code points."}}),
		"RoutingOrderPreviewRequest":  object([]string{"model", "complexity", "rule_order", "rule_revision"}, map[string]any{"model": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}, "complexity": map[string]any{"type": "integer", "minimum": 0, "maximum": 100}, "rule_order": order, "rule_revision": revision}),
		"RoutingOrderDecision":        object([]string{"matched_rule_id", "applied", "target_model", "target_provider"}, map[string]any{"matched_rule_id": text, "applied": flag, "target_model": text, "target_provider": text}),
		"RoutingOrderPreviewResponse": object([]string{"stage", "revision", "ambiguous_before_order", "before", "after"}, map[string]any{"stage": map[string]any{"type": "string", "enum": []string{"complexity_rules"}}, "revision": revision, "ambiguous_before_order": flag, "before": schemaRef("RoutingOrderDecision"), "after": schemaRef("RoutingOrderDecision")}),
		"RoutingPreviewRequest":       map[string]any{"oneOf": []any{schemaRef("RoutingOrderPreviewRequest"), schemaRef("RoutingDraftPreviewRequest"), legacyRequest}},
		"RoutingPreviewResponse":      map[string]any{"oneOf": []any{schemaRef("RoutingOrderPreviewResponse"), schemaRef("RoutingDraftPreviewResponse"), legacyResponse}},
	}
}
