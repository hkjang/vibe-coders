package proxy

func enrichRoutingDomainReviewOpenAPI(method string, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	if method == "get" {
		op["description"] = "Read the recent domain review queue with routing:read and raw-prompt permission. JWT roles super_admin, admin and security_admin may read raw data when they have the scope; the full legacy admin token and unauthenticated open mode also permit it. Legacy read-only credentials and other JWT roles cannot read this queue. Every item includes unmasked query_text and other stored text; this is not a redacted or PII-free projection. status is trimmed and defaults to pending; any nonempty status is matched literally, with no closed enum. A missing or blank window imposes no time bound. A supplied window accepts 24h, 7d, 30d, 90d or a positive Go duration; invalid/nonpositive input uses seven days. The time filter is inclusive on created_at, not reviewed_at. limit defaults to 50 for omitted/invalid/nonpositive text and is capped at 200 after integer parsing. Rows are ordered by created_at descending, with no tie-break ordering guarantee. This is a limited recent list, not cursor pagination, a total count, snapshot or revision. route, request_id, team and team_id do not filter this queue. GET neither changes queue status nor creates examples or rules."
		op["parameters"] = []any{
			map[string]any{"name": "status", "in": "query", "required": false,
				"description": "Trimmed literal status filter; omitted/blank selects pending. Unknown strings are accepted and normally return an empty list.",
				"schema":      map[string]any{"type": "string", "default": "pending"}},
			map[string]any{"name": "window", "in": "query", "required": false,
				"description": "Omitted/blank has no lower bound. 24h/7d/30d/90d or any positive Go duration is accepted; other nonblank input defaults to seven days. No closed enum or request validation range.",
				"schema":      map[string]any{"type": "string"}},
			map[string]any{"name": "limit", "in": "query", "required": false,
				"description": "Trimmed query text parsed by strconv.Atoi. Missing, invalid, overflow or nonpositive values use 50; positive parsed values above 200 are capped at 200. These are normalization rules, not rejection bounds.",
				"schema":      map[string]any{"type": "string", "default": "50"}},
		}
		responses["200"] = successResponse("RoutingDomainReviewReport")
		responses["401"] = errorResponse("invalid_api_key: existing authentication or routing:read scope rejection.")
		responses["403"] = errorResponse("raw_prompt_access_required: authenticated routing reader lacks raw-prompt permission; no queue payload is returned.")
		responses["405"] = errorResponse("method_not_allowed: the queue handler requires GET after authorization.")
		responses["500"] = errorResponse("domain_review_failed: queue storage read failed.")
		return
	}
	op["description"] = "Set a review status with routing:write; POST has no raw-prompt role check. The existing {id} parameter carries the encoded review ID followed by /approve or /reject, including the action inside that parameter. The handler splits the decoded request path at its first slash; it preserves the ID exactly and only tests strings.TrimSpace(id) for emptiness. The entire remaining action must be approve or reject. Encode the full ID/action value once, including the separator; literal percent signs require percent encoding and an encoded separator keeps a dot ID from becoming a standalone path segment. The request body is unused. A successful SQL UPDATE changes only status and reviewed_at, then attempts best-effort admin audit. It does not create or approve domain examples, change routing rules or invalidate the routing cache. There is no pending-state, existence, affected-row, revision/CAS or idempotency check: repeated and nonexistent IDs also return 200, and repeated updates refresh reviewed_at. The acknowledgment echoes the decoded requested ID and approved/rejected action status, not a row snapshot or proof a row existed. Concurrent actions can overwrite one another; a subsequent GET is current state, not proof of which request wrote it. Response loss may occur after the update; audit failure does not roll it back."
	responses["200"] = successResponse("RoutingDomainReviewAck")
	responses["400"] = errorResponse("invalid_review_path: no ID/action separator or whitespace-only decoded ID; invalid_review_action: the decoded action is not exactly approve or reject.")
	responses["401"] = errorResponse("invalid_api_key: existing authentication or routing:write scope rejection, including legacy read-only credentials. A raw-prompt role or admin:write alone does not grant routing:write.")
	responses["405"] = errorResponse("method_not_allowed: the action handler requires POST after authorization.")
	responses["500"] = errorResponse("domain_review_update_failed: SQL UPDATE failed. A nonexistent ID alone does not produce a 404; an unconfirmed response does not prove no update occurred.")
}

func routingDomainReviewOpenAPISchemas() map[string]any {
	text := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	return map[string]any{
		"RoutingDomainReviewReport": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"items"},
			"properties": map[string]any{
				"items": map[string]any{"type": "array", "items": schemaRef("RoutingDomainReviewItem"), "description": "Recent matching rows; empty is [], not null. No total, cursor or revision is included."},
			},
		},
		"RoutingDomainReviewItem": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"id", "decision_id", "query_text", "suggested_route", "current_route", "reason", "status", "created_at", "reviewed_at"},
			"properties": map[string]any{
				"id":              text("Stored review ID; exact spelling is preserved."),
				"decision_id":     text("Stored decision ID; no implicit detail fetch or existence check."),
				"query_text":      text("Stored unmasked query text. The current producer collapses whitespace and limits it to 2000 bytes, so it is not a full-fidelity original prompt. Raw-prompt permission is required for this entire report."),
				"suggested_route": text("Stored proposed domain route, not an applied routing rule."),
				"current_route":   text("Recorded model value from the MCP discovery policy at enqueue time (policy.Model), despite the legacy current_route field name; not a live current route or a before/after comparison with suggested_route. Absent storage value is an empty string."),
				"reason":          text("Stored unmasked reason; absent storage value is an empty string."),
				"status":          text("Stored status, commonly pending/approved/rejected. Extensible string, not a closed enum."),
				"created_at":      text("Stored creation timestamp string; returned without date parsing or normalization."),
				"reviewed_at":     text("Stored review timestamp string, or empty string when unreviewed; never null. Not a revision token."),
			},
		},
		"RoutingDomainReviewAck": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"id", "status"},
			"properties": map[string]any{
				"id":     text("Exact decoded request-path ID; does not prove a matching row existed."),
				"status": map[string]any{"type": "string", "enum": []string{"approved", "rejected"}, "description": "Status requested by the successful action; no row snapshot or timestamp is returned."},
			},
		},
	}
}
