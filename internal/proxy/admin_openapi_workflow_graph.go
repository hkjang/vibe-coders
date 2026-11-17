package proxy

func workflowGraphOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	flow := object([]string{"version", "entry", "edges"}, map[string]any{
		"version": map[string]any{"type": "integer", "enum": []int{1}}, "entry": text,
		"edges": map[string]any{"type": "array", "maxItems": 256, "items": schemaRef("WorkflowGraphEdge")},
	})
	condition := object([]string{"operator"}, map[string]any{"operator": map[string]any{"type": "string", "enum": []string{"non_empty", "equals", "contains"}}, "value": map[string]any{"type": "string", "description": "Case-sensitive comparison value, at most 4096 UTF-8 bytes; empty for non_empty and nonempty for contains."}})
	step := object([]string{"id", "name", "type"}, map[string]any{
		"id": map[string]any{"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$"}, "name": text,
		"type": map[string]any{"type": "string", "enum": []string{"chat", "skill", "text2sql", "mcp_tool", "condition", "approval", "transform"}},
		"ref":  text, "note": text, "condition": schemaRef("WorkflowGraphCondition"),
		"timeout_ms":     map[string]any{"type": "integer", "minimum": 0, "maximum": 300000},
		"max_tokens":     map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "description": "Nonzero only for chat/skill."},
		"max_cost_krw":   map[string]any{"type": "number", "enum": []int{0}, "description": "Per-step cost bounds are not enforced and cannot be enabled in graph mode."},
		"allowed_tools":  map[string]any{"type": "array", "items": text, "description": "Exact namespaced MCP tool names; nonempty only for mcp_tool."},
		"allowed_tables": map[string]any{"type": "array", "maxItems": 0, "items": text},
	})
	input := object([]string{"id", "name", "description", "allowed_teams", "enabled", "steps", "flow"}, map[string]any{
		"id": text, "name": text, "description": text, "allowed_teams": text, "enabled": map[string]any{"type": "boolean"},
		"steps": map[string]any{"type": "array", "minItems": 1, "maxItems": 128, "items": schemaRef("WorkflowGraphStep")}, "flow": schemaRef("WorkflowGraphFlow"),
	})
	review := object([]string{"workflow", "revision"}, map[string]any{"workflow": schemaRef("WorkflowDefinition"), "revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}})
	return map[string]any{
		"WorkflowGraphPublishRequest": object([]string{"expected_revision", "note"}, map[string]any{"expected_revision": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}, "note": map[string]any{"type": "string", "minLength": 1, "maxLength": 500}}),
		"WorkflowPublishResult":       object([]string{"workflow_id", "version", "enabled", "published"}, map[string]any{"workflow_id": text, "version": map[string]any{"type": "integer", "minimum": 1}, "enabled": map[string]any{"type": "boolean"}, "published": map[string]any{"type": "boolean"}}),
		"WorkflowPublishedVersion": object([]string{"id", "workflow_id", "version", "name", "description", "steps", "allowed_teams", "published_by", "published_at", "note"}, map[string]any{
			"id": text, "workflow_id": text, "version": map[string]any{"type": "integer"}, "name": text, "description": text, "steps": map[string]any{"type": "array", "nullable": true, "items": schemaRef("WorkflowDefinitionStep")}, "flow": schemaRef("WorkflowGraphFlow"), "allowed_teams": text, "published_by": text, "published_at": text, "note": text,
		}),
		"WorkflowPublishedVersions": object([]string{"workflow_id", "versions"}, map[string]any{"workflow_id": text, "versions": map[string]any{"type": "array", "items": schemaRef("WorkflowPublishedVersion")}}),
		"WorkflowReceiptStep": object([]string{"step_index", "name", "type", "ref", "status", "output_chars", "error_class"}, map[string]any{
			"step_index": map[string]any{"type": "integer"}, "name": text, "type": text, "ref": text, "status": text, "output_chars": map[string]any{"type": "integer"}, "error_class": text,
			"step_id": text, "definition_index": map[string]any{"type": "integer", "minimum": 0}, "branch": map[string]any{"type": "string", "enum": []string{"true", "false"}},
		}),
		"WorkflowExecutionReceipt": object([]string{"run_id", "kind", "workflow_id", "workflow_name", "status", "error_class", "steps_total", "steps_ok", "latency_ms", "cost_krw", "created_at", "steps", "note"}, map[string]any{
			"run_id": text, "kind": map[string]any{"type": "string", "enum": []string{"workflow"}}, "workflow_id": text, "workflow_name": text, "status": text, "error_class": text,
			"steps_total": map[string]any{"type": "integer"}, "steps_ok": map[string]any{"type": "integer"}, "latency_ms": map[string]any{"type": "integer"}, "cost_krw": map[string]any{"type": "number"}, "created_at": text, "note": text, "steps": map[string]any{"type": "array", "items": schemaRef("WorkflowReceiptStep")},
		}),
		"WorkflowGraphEdge": object([]string{"from", "to", "when"}, map[string]any{"from": text, "to": map[string]any{"type": "string", "description": "Existing step ID or $end."}, "when": map[string]any{"type": "string", "enum": []string{"next", "true", "false"}}}),
		"WorkflowGraphFlow": flow, "WorkflowGraphCondition": condition, "WorkflowGraphStep": step, "WorkflowGraphInput": input, "WorkflowGraphReview": review,
		"WorkflowGraphWriteRequest": object([]string{"workflow", "expected_revision", "reason"}, map[string]any{"workflow": schemaRef("WorkflowGraphInput"), "expected_revision": map[string]any{"type": "string", "pattern": "^([a-f0-9]{64})?$", "description": "Empty means create-only; otherwise the complete reviewed definition token."}, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 500}}),
	}
}

func enrichWorkflowGraphWriteOpenAPI(op, responses map[string]any) {
	op["description"] = "Without review, retain the legacy workflow upsert. Exactly review=graph selects a strict UTF-8 JSON graph contract (256 KiB): require admin:read and admin:write, validate a single-path DAG of at most 128 steps, and atomically save the full definition plus audit after checking the complete revision under a database writer lock. Empty revision is create-only; a stale or deleted definition returns 409. Enabled definitions apply to the next run immediately; published snapshots do not pin execution. Neither graph saving nor validation executes models or tools. Never automatically retry an unconfirmed write. A legacy edit cannot remove an existing graph by omitting flow."
	op["parameters"] = []any{map[string]any{"name": "review", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"graph"}}}}
	op["requestBody"] = map[string]any{"required": true, "content": jsonContent(map[string]any{"anyOf": []any{schemaRef("WorkflowGraphWriteRequest"), map[string]any{"type": "object", "additionalProperties": true, "description": "Legacy request when review is absent."}}})}
	responses["200"] = map[string]any{"description": "Graph review response, or legacy id/ok acknowledgment without review.", "content": jsonContent(map[string]any{"anyOf": []any{schemaRef("WorkflowGraphReview"), map[string]any{"type": "object", "additionalProperties": true}}})}
	for code, description := range map[string]string{"400": "invalid_workflow_graph: malformed/duplicate/unknown/null fields, invalid graph, revision, reason or size.", "401": "invalid_api_key: authentication or required admin scopes denied.", "409": "workflow_graph_conflict: changed/deleted definition, repeated create, or legacy edit omits graph.", "500": "workflow_graph_failed: read, write or audit failed. Unconfirmed response is not proof of non-application."} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func enrichWorkflowGraphPublishOpenAPI(op, responses map[string]any) {
	op["description"] = "Snapshot and enable the currently stored workflow. For graph definitions, require strict JSON expected_revision and nonblank note (at most 500 Unicode code points), both admin:read/write, no query, and at most 8192 body bytes. Validate before locking, then atomically compare the reviewed definition, allocate a version, save its complete graph snapshot, enable it and record audit. A changed/deleted definition returns 409; unconfirmed writes must not automatically retry. Legacy sequence definitions retain the optional note body. Execution uses the current definition, not a published version."
	op["requestBody"] = map[string]any{"content": jsonContent(map[string]any{"anyOf": []any{schemaRef("WorkflowGraphPublishRequest"), map[string]any{"type": "object", "properties": map[string]any{"note": map[string]any{"type": "string"}}, "description": "Legacy sequence publication only."}}})}
	responses["200"] = successResponse("WorkflowPublishResult")
	for code, desc := range map[string]string{"400": "Invalid graph, reason, body, query or validation.", "401": "Read or write authorization denied.", "409": "Reviewed workflow changed or was deleted.", "500": "Publication failed or outcome unconfirmed; do not retry automatically."} {
		responses[code] = map[string]any{"description": desc, "content": jsonContent(schemaRef("AppError"))}
	}
}
