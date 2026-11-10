package proxy

func enrichRequestIOPreviewsOpenAPI(op, responses map[string]any) {
	op["description"] = "Masked input and output previews for at most 100 requests, for a listing that shows them at a glance. Text is masked for every role, and requests outside the caller's team scope are omitted rather than denied."
	op["parameters"] = []any{
		map[string]any{"in": "query", "name": "ids", "required": true, "description": "Comma-separated request IDs, at most 100.", "schema": map[string]any{"type": "string", "maxLength": requestIOIDListBytes}},
	}
	responses["200"] = successResponse("RequestIOPreviewsResponse")
}

func enrichRequestIOOpenAPI(op, responses map[string]any) {
	op["description"] = "Full input and output of one request. Masked for every role by default. reveal=raw returns originals to roles allowed to see them and writes a request.raw_view audit entry first; a failed audit returns nothing."
	op["parameters"] = []any{
		map[string]any{"in": "path", "name": "id", "required": true, "schema": map[string]any{"type": "string"}},
		map[string]any{"in": "query", "name": "reveal", "required": false, "schema": map[string]any{"type": "string", "enum": []string{"raw"}}},
	}
	responses["200"] = successResponse("RequestIODetail")
}

func requestIOOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	boolean := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "minimum": 0}
	state := map[string]any{"type": "string", "enum": []string{requestIOStateCaptured, requestIOStateNotCaptured, requestIOStateMissing},
		"description": "not_captured: the call answered but its body was not kept (LOG_RESPONSE_TEXT off). missing: no record exists."}
	kind := map[string]any{"type": "string", "enum": []string{requestOutputKindNone, requestOutputKindText, requestOutputKindToolCalls, requestOutputKindError, requestOutputKindEmbedding, requestOutputKindImage}}
	stringArray := map[string]any{"type": "array", "items": text}
	capture := map[string]any{
		"type": "object", "additionalProperties": false,
		"required":    []string{"response_text", "raw_prompts", "response_max_bytes"},
		"description": "Current capture settings. They decide what new requests keep, not what older rows hold.",
		"properties":  map[string]any{"response_text": boolean, "raw_prompts": boolean, "response_max_bytes": count},
	}
	return map[string]any{
		"RequestIOPreview": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"request_id", "input", "output"},
			"properties": map[string]any{
				"request_id": text,
				"input": map[string]any{
					"type": "object", "additionalProperties": false,
					"required": []string{"state", "role", "text", "truncated", "chars", "message_count"},
					"properties": map[string]any{
						"state": state, "role": text, "text": text, "truncated": boolean, "chars": count, "message_count": count,
					},
				},
				"output": map[string]any{
					"type": "object", "additionalProperties": false,
					"required": []string{"state", "kind", "text", "truncated", "chars", "tool_names", "finish_reason"},
					"properties": map[string]any{
						"state": state, "kind": kind, "text": text, "truncated": boolean, "chars": count, "tool_names": stringArray, "finish_reason": text,
					},
				},
			},
		},
		"RequestIOPreviewsResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"previews", "capture", "generated_at"},
			"properties": map[string]any{
				"previews":     map[string]any{"type": "array", "maxItems": requestIOMaxIDs, "items": schemaRef("RequestIOPreview")},
				"capture":      capture,
				"generated_at": map[string]any{"type": "string", "format": "date-time"},
			},
		},
		"RequestIODetail": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"request_id", "created_at", "method", "endpoint", "stream", "status_code", "error", "requested_model", "resolved_model", "provider", "route_reason", "failover", "fallback_from", "languages", "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens", "token_source", "estimated_cost", "currency", "latency_ms", "first_chunk_ms", "api_key_id", "client_ip", "user_agent", "session_id", "trace_id", "input", "output", "capture", "masked", "raw_allowed"},
			"properties": map[string]any{
				"request_id": text, "created_at": text, "method": text, "endpoint": text, "stream": boolean,
				"status_code": count, "error": text, "requested_model": text, "resolved_model": text, "provider": text,
				"route_reason": text, "failover": boolean, "fallback_from": text, "languages": stringArray,
				"prompt_tokens": count, "completion_tokens": count, "total_tokens": count, "cached_tokens": count, "reasoning_tokens": count,
				"token_source": text, "estimated_cost": map[string]any{"type": "number", "minimum": 0}, "currency": text,
				"latency_ms": count, "first_chunk_ms": count, "api_key_id": text, "client_ip": text, "user_agent": text, "session_id": text, "trace_id": text,
				"input": map[string]any{
					"type": "object", "additionalProperties": false,
					"required": []string{"state", "messages", "omitted_messages", "tool_definitions"},
					"properties": map[string]any{
						"state": state, "omitted_messages": count, "tool_definitions": text,
						"messages": map[string]any{"type": "array", "maxItems": requestIOMaxMessages, "items": map[string]any{
							"type": "object", "additionalProperties": false,
							"required":   []string{"role", "text", "chars", "truncated", "original_kept"},
							"properties": map[string]any{"role": text, "text": text, "chars": count, "truncated": boolean, "original_kept": boolean},
						}},
					},
				},
				"output": map[string]any{
					"type": "object", "additionalProperties": false,
					"required": []string{"state", "kind", "text", "chars", "truncated", "tool_calls", "finish_reason", "original_kept"},
					"properties": map[string]any{
						"state": state, "kind": kind, "text": text, "chars": count, "truncated": boolean, "finish_reason": text,
						"original_kept": map[string]any{"type": "boolean", "description": "Only rows stored before responses were masked on write still hold an original."},
						"tool_calls": map[string]any{"type": "array", "items": map[string]any{
							"type": "object", "additionalProperties": false,
							"required":   []string{"name", "arguments"},
							"properties": map[string]any{"name": text, "arguments": text},
						}},
					},
				},
				"capture": capture, "masked": boolean, "raw_allowed": boolean,
			},
		},
	}
}
