package proxy

func enrichRoutingDomainDecisionsOpenAPI(op, responses map[string]any) {
	op["description"] = "Read recent recorded domain routing decisions and their signals with routing:read and raw-prompt permission; routing:write is not required. JWT roles super_admin, admin and security_admin may read raw data when they have the scope; the full legacy admin token and unauthenticated open mode also permit it. Legacy read-only credentials and other JWT roles cannot read this report. Stored strings, including identifiers, tools, reasons and embedded evidence errors, are unmasked; this is not a redacted or PII-free projection. route and request_id are trimmed, optional exact-match filters, combined with AND. A missing or blank window imposes no time bound. A supplied window accepts 24h, 7d, 30d, 90d or a positive Go duration; invalid/nonpositive input uses seven days. The time filter is inclusive on created_at. limit defaults to 50 for omitted/invalid/nonpositive text and is capped at 200 after integer parsing. Decisions are ordered by created_at descending, with no tie-break ordering guarantee. This is a limited recent list, not cursor pagination; no total, cursor or revision is returned. team and team_id do not filter results, and there is no implicit caller-team scope. The decision list and each exact decision-ID signal lookup are separate non-atomic queries, not a consistent snapshot. Successful empty signal reads produce []; ignored query/scan failures produce null, and a late iteration failure can leave a partial array. There is no signal-completeness flag or per-entry error metadata. Signal arrays are ordered by created_at ascending then source ascending, with no further tie-break guarantee. Recorded scores are not calibrated probabilities, and recorded false fallback/governance flags are not proof those events never occurred. GET does not change decisions, signals, review status, examples, routing rules or runtime caches and performs no automatic promotion."
	op["parameters"] = []any{
		map[string]any{"name": "route", "in": "query", "required": false,
			"description": "Trimmed exact stored route match; omitted/blank imposes no route filter. Extensible string, not a closed route enum, substring search or wildcard pattern.",
			"schema":      map[string]any{"type": "string"}},
		map[string]any{"name": "request_id", "in": "query", "required": false,
			"description": "Trimmed exact stored request ID match; omitted/blank imposes no request filter. Combined with route and window, not used as the signal join key.",
			"schema":      map[string]any{"type": "string"}},
		map[string]any{"name": "window", "in": "query", "required": false,
			"description": "Omitted/blank has no lower time bound. Trimmed 24h/7d/30d/90d or any positive Go duration is accepted; other nonblank input defaults to seven days. This is tolerant normalization, not an enum or validation range.",
			"schema":      map[string]any{"type": "string"}},
		map[string]any{"name": "limit", "in": "query", "required": false,
			"description": "Trimmed query text parsed by strconv.Atoi. Missing, invalid, overflow or nonpositive values use 50; positive parsed values above 200 are capped at 200. These are normalization rules, not rejection bounds.",
			"schema":      map[string]any{"type": "string", "default": "50"}},
	}
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["200"] = successResponse("RoutingDomainDecisionReport")
	responses["401"] = errorResponse("invalid_api_key: existing authentication or routing:read scope rejection; a raw-prompt role or admin:read alone is insufficient.")
	responses["403"] = errorResponse("raw_prompt_access_required: the authenticated routing reader lacks raw-prompt permission; no decision payload is returned.")
	responses["405"] = errorResponse("method_not_allowed: the handler requires GET after authorization.")
	responses["500"] = errorResponse("domain_decisions_failed: decision-list storage read failed. The message contains storage error text and is not a safe display projection. Signal lookup failures alone remain HTTP 200.")
}

func routingDomainDecisionsOpenAPISchemas() map[string]any {
	text := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	number := func(description string) map[string]any {
		return map[string]any{"type": "number", "description": description}
	}
	return map[string]any{
		"RoutingDomainDecisionReport": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"decisions", "signals"},
			"properties": map[string]any{
				"decisions": map[string]any{"type": "array", "items": schemaRef("RoutingDomainDecision"), "description": "Recent matching records; empty is [], not null. This is not a total count or paginated snapshot."},
				"signals": map[string]any{
					"type":        "object",
					"description": "One key per returned decision, using its exact stored ID, including arbitrary or empty strings. Empty report is {}. Separate lookups are non-atomic with the decision list. A successful empty lookup is []; an ignored query/scan failure is null. A late iteration error may leave a partial array, so a non-null array is not a completeness guarantee. No per-entry error or completeness metadata is returned.",
					"additionalProperties": map[string]any{
						"type": "array", "nullable": true, "items": schemaRef("RoutingDomainSignal"),
					},
				},
			},
		},
		"RoutingDomainDecision": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"id", "request_id", "user_id", "team_id", "query_hash", "route", "confidence", "tool_names", "evidence_score", "evidence_count", "fallback_used", "blocked_by_governance", "reason", "created_at"},
			"properties": map[string]any{
				"id":                    text("Exact stored decision ID and signal-map key; arbitrary spelling is preserved, with no format or nonempty guarantee."),
				"request_id":            text("Stored request ID, returned without masking; not a signal join key or an authorization boundary."),
				"user_id":               text("Stored user ID; absent storage value is an empty string. Not an implicit caller filter."),
				"team_id":               text("Stored team ID; absent storage value is an empty string. The report is not team-scoped."),
				"query_hash":            text("Stored query hash string. The current producer hashes the query, but this field is returned without hash-format validation and does not make the other raw fields PII-free."),
				"route":                 text("Recorded domain route, not a live routing rule or selected model. Current MCP producer maps its policy model to company_policy/legal/compliance/research/grounded; stored values remain extensible strings."),
				"confidence":            number("Stored score. The current MCP producer copies the first candidate FinalScore, or zero when no candidates exist; not a calibrated probability or normalized confidence range."),
				"tool_names":            map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Stored tool-name array; the current MCP producer records candidate upstream-ID/tool-name pairs, not proof each tool was called. Ordering, duplicates and empty strings are preserved. NULL/null/undecodable storage normalizes to [] when no slice was decoded; partially decoded malformed arrays can contain empty strings. Never null."},
				"evidence_score":        number("Stored score. The current MCP producer takes the maximum filtered evidence score with a zero floor, not an average; stored values have no declared 0..1 validation range."),
				"evidence_count":        map[string]any{"type": "integer", "description": "Stored integer; the current MCP producer records the number of filtered evidence entries, not a successful-tool or signal count. No storage validation minimum is imposed by this report."},
				"fallback_used":         map[string]any{"type": "boolean", "description": "Recorded flag, true only for stored integer 1. The current MCP learning producer leaves it false, including when an evidence_gate signal is emitted; false does not prove no fallback occurred."},
				"blocked_by_governance": map[string]any{"type": "boolean", "description": "Recorded flag, true only for stored integer 1. The current MCP learning producer leaves it false; false does not prove no governance gate or block occurred."},
				"reason":                text("Stored unmasked diagnostic reason, or empty string for an absent value. The current producer includes model/mode/first candidate and the first filtered evidence score, which need not equal the maximum evidence_score field."),
				"created_at":            text("Stored creation timestamp string, returned without date parsing or normalization; not a revision token."),
			},
		},
		"RoutingDomainSignal": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"id", "decision_id", "source", "route", "score", "reason", "created_at"},
			"properties": map[string]any{
				"id":          text("Exact stored signal ID, returned without masking or format validation."),
				"decision_id": text("Exact decision ID used by the signal lookup, not the request ID."),
				"source":      text("Extensible stored source string. Current producer sources include explicit_model, selector, mcp_evidence and evidence_gate; these are not a closed enum."),
				"route":       text("Stored signal route; not assumed to equal the decision route or a live routing configuration."),
				"score":       number("Stored source-specific score, not a common probability scale. Current producer uses 0.99 for explicit_model, candidate FinalScore for selector, every raw evidence score for mcp_evidence (including excluded/error evidence), and zero for evidence_gate. No declared 0..1 validation range."),
				"reason":      text("Stored unmasked reason, or empty string for an absent value; may include raw model/tool identifiers and upstream evidence error text. An evidence_gate reason does not establish automatic fallback or set the decision flags."),
				"created_at":  text("Stored timestamp string, returned without date parsing or normalization. Arrays sort by this value ascending then source ascending."),
			},
		},
	}
}
