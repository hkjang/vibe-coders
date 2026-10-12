package proxy

func enrichKillSwitchOpenAPIOperation(method string, op, responses map[string]any) {
	responses["200"] = successResponse("KillSwitchState")
	responses["401"] = map[string]any{"description": "Admin read permission required for GET; admin write required for POST", "content": jsonContent(schemaRef("AppError"))}
	if method == "get" {
		op["description"] = "Uncached persisted flag read plus an optional fresh responding-process traffic observation, served with Cache-Control:no-store. Missing flag means false; database failures and unrecognized persisted values return503, not fabricated normal operation. State and traffic are separate snapshots, not an atomic cluster snapshot. Common proxy entry gate only; admitted work and separately registered /v1 features are not all stopped. Inference cache TTL and error behavior remain independent."
		responses["503"] = map[string]any{"description": "kill_switch_state_unavailable: database read failed, was cancelled, or contained an unrecognized flag", "content": jsonContent(schemaRef("AppError"))}
		return
	}
	op["description"] = "Commits the flag and kill_switch.set admin audit atomically, then returns that transaction's snapshot without a follow-up read. Statement or validation failures roll back both; a commit acknowledgment error returns no success snapshot and must be treated as uncertain, not automatically replayed. Cache invalidation and external post-change work happen only after successful commit. Other processes retain the existing cache TTL. Legacy omission/null behavior is retained: disabled defaults false, reason defaults empty; the React review requires a nonempty reason and local target phrase. No optimistic concurrency or idempotency key."
	op["requestBody"] = requestBody("KillSwitchChangeRequest")
	responses["400"] = map[string]any{"description": "invalid_body: JSON cannot be decoded", "content": jsonContent(schemaRef("AppError"))}
	responses["500"] = map[string]any{"description": "kill_switch_save_failed: flag/audit transaction could not be confirmed; verify state before a new explicit change", "content": jsonContent(schemaRef("AppError"))}
}

func killSwitchOpenAPISchemas() map[string]any {
	return map[string]any{
		"KillSwitchChangeRequest": map[string]any{
			"type": "object", "nullable": true,
			"properties": map[string]any{
				"disabled": map[string]any{"type": "boolean", "nullable": true},
				"reason":   map[string]any{"type": "string", "nullable": true},
			},
		},
		"KillSwitchState": map[string]any{
			"type": "object", "required": []string{"disabled"},
			"properties": map[string]any{
				"disabled":   map[string]any{"type": "boolean"},
				"reason":     map[string]any{"type": "string"},
				"updated_at": map[string]any{"type": "string"},
				"updated_by": map[string]any{"type": "string"},
				"traffic":    schemaRef("KillSwitchTrafficObservation"),
			},
		},
		"KillSwitchTrafficObservation": map[string]any{
			"type": "object", "required": []string{"scope", "instance_ref", "observed_at", "proxy_inflight"},
			"description": "Optional GET observation. Absence means unavailable, not zero. A responding-process snapshot, not cluster-wide traffic or confirmation of flag propagation. Counts common OpenAI proxy handlers (including local checks, streaming and cleanup), not separately registered workflow/app/receipt/skill routes, MCP or admin requests.",
			"properties": map[string]any{
				"scope":          map[string]any{"type": "string", "enum": []string{"responding_process"}},
				"instance_ref":   map[string]any{"type": "string", "pattern": "^process_[a-f0-9]{16}$", "description": "Opaque process reference; may change between load-balanced responses or restarts. Not a hostname."},
				"observed_at":    map[string]any{"type": "string", "format": "date-time"},
				"proxy_inflight": map[string]any{"type": "integer", "minimum": 0, "description": "Active common proxy handlers observed in this process. Does not estimate how many requests the stop will cancel; admitted work is not cancelled."},
			},
		},
	}
}
