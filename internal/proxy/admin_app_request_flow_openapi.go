package proxy

func enrichAppRequestFlowOpenAPI(op, responses map[string]any) {
	op["description"] = "Read-only safe metadata for one v2 request_ref and its original canonical UTC nanosecond created_at. Exactly these two query parameters, once each; raw identifiers are never accepted. admin:read is required; existing gateway authentication returns 401 for missing credentials or insufficient scope. Current team checks and existing JWT/team-cache semantics apply, not atomic/global revocation. Candidate overflow, missing records, ref mismatch and team denial share one 404. Responses always use no-store and never include raw IDs, prompts, errors, headers, SQL or arguments, including for raw-prompt administrators. Bounded child candidates are filtered/sorted only after their limit; neither earliest/all children nor a complete distributed trace is promised. Recorded times/latencies do not establish execution start or measured tool duration. Authentication denial can still write existing auth audit events."
	op["parameters"] = []any{
		map[string]any{"in": "query", "name": "request_ref", "required": true, "schema": map[string]any{"type": "string", "pattern": `^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$`}},
		map[string]any{"in": "query", "name": "created_at", "required": true, "schema": appFlowOpenAPITime(false), "description": "Pass the original list string unchanged; JavaScript Date roundtrips lose nanoseconds."},
	}
	responses["200"] = successResponse("AppRequestFlowResponse")
	for code, description := range map[string]string{
		"400": "Invalid, missing, duplicate or additional query parameters",
		"401": "Existing gateway authentication or admin:read scope check failed",
		"404": "app_request_flow_unavailable: unavailable without distinguishing missing, scoped or bounded-resolution cases",
		"500": "Safe database/read failure, not an empty successful flow",
	} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func appFlowOpenAPITime(nullable bool) map[string]any {
	return map[string]any{"type": "string", "format": "date-time", "minLength": 30, "maxLength": 30,
		"pattern": `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$`, "nullable": nullable}
}

func appRequestFlowOpenAPISchemas() map[string]any {
	spanRef := map[string]any{"type": "string", "pattern": `^span_[A-Za-z0-9_-]{43}$`}
	coverage := map[string]any{
		"type": "object", "additionalProperties": false, "required": []string{"limit", "truncated", "omitted"},
		"properties": map[string]any{
			"limit":     map[string]any{"type": "integer", "enum": []int{100}},
			"truncated": map[string]any{"type": "boolean"},
			"omitted":   map[string]any{"type": "integer", "minimum": 0, "maximum": 100, "description": "Excluded candidates within the bounded first 100, not a count of all hidden records."},
		},
	}
	return map[string]any{
		"AppRequestFlowSpan": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"span_ref", "parent_ref", "kind", "name", "status", "recorded_at", "offset_ms", "duration_ms"},
			"properties": map[string]any{
				"span_ref":    spanRef,
				"parent_ref":  map[string]any{"type": "string", "pattern": `^span_[A-Za-z0-9_-]{43}$`, "nullable": true},
				"kind":        map[string]any{"type": "string", "enum": []string{"request", "text2sql", "tool", "mcp_tool"}},
				"name":        map[string]any{"type": "string", "minLength": 1, "maxLength": 256, "description": "Safe display text, additionally capped at 256 UTF-8 bytes."},
				"status":      map[string]any{"type": "string", "enum": []string{"ok", "error", "skipped", "unknown"}},
				"recorded_at": appFlowOpenAPITime(true),
				"offset_ms":   map[string]any{"type": "integer", "minimum": -appRequestMaxSafeInteger, "maximum": appRequestMaxSafeInteger, "nullable": true, "description": "Signed recorded-time difference from the root record, truncated to milliseconds; not execution start."},
				"duration_ms": map[string]any{"type": "integer", "minimum": 0, "maximum": appRequestMaxSafeInteger, "nullable": true, "description": "Stored nonnegative safe-integer latency, not measured provenance; tools always null."},
			},
		},
		"AppRequestFlowResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required":    []string{"flow_version", "request_ref", "created_at", "generated_at", "spans", "coverage"},
			"description": "Exactly one first root span (kind=request, parent_ref=null); all later children refer to that root, with unique opaque refs. Maximum 201 spans. No raw identifiers or payload fields.",
			"properties": map[string]any{
				"flow_version": map[string]any{"type": "integer", "enum": []int{1}},
				"request_ref":  map[string]any{"type": "string", "pattern": `^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$`},
				"created_at":   appFlowOpenAPITime(false),
				"generated_at": appFlowOpenAPITime(false),
				"spans":        map[string]any{"type": "array", "minItems": 1, "maxItems": 201, "items": schemaRef("AppRequestFlowSpan")},
				"coverage": map[string]any{
					"type": "object", "additionalProperties": false, "required": []string{"tools", "text2sql"},
					"properties": map[string]any{"tools": coverage, "text2sql": coverage},
				},
			},
		},
	}
}
