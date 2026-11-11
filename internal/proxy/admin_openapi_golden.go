package proxy

// Documents existing read APIs without changing the runner or authorization.
func enrichGoldenReadOpenAPI(key string, op, responses map[string]any) {
	op["description"] = "Existing regression registry requiring admin:read. Reads never execute models. Text is stored content, not a server-redacted projection."
	if key == "get /admin/golden-prompts" {
		op["parameters"] = []any{
			map[string]any{"name": "prompt_id", "in": "query", "required": false, "schema": map[string]any{"type": "string"}, "description": "Filters results only; the complete prompt registry is still returned."},
			map[string]any{"name": "limit", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 200, "default": 50}, "description": "Recent results in descending creation time. No cursor or total count. Values above 200 are capped; invalid/nonpositive values use 50."},
		}
		responses["200"] = successResponse("GoldenPromptListResponse")
	} else {
		op["description"] = "Existing ordered regression definitions requiring admin:read. Steps are independent prompts, not chained outputs. No persisted workflow-run history. Null steps mean absent or undecodable stored steps. Reads never execute models."
		responses["200"] = successResponse("GoldenWorkflowListResponse")
	}
	for _, status := range []string{"401", "405", "500"} {
		responses[status] = map[string]any{"description": "Existing authorization, method or storage error", "content": jsonContent(schemaRef("AppError"))}
	}
}

func goldenReadOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	strings := map[string]any{"type": "array", "nullable": true, "items": text}
	number := map[string]any{"type": "number"}
	object := func(required []string, fields map[string]any) map[string]any {
		return map[string]any{"type": "object", "required": required, "properties": fields}
	}
	array := func(name string) map[string]any { return map[string]any{"type": "array", "items": schemaRef(name)} }
	stepFields := map[string]any{
		"name": text, "prompt": text, "expected": text, "task_type": text, "selected_model": text,
		"baseline_score": number, "contract_id": text, "rubric_id": text, "source_run_id": text,
	}
	return map[string]any{
		"GoldenPromptWriteBody": object([]string{"name", "prompt"}, map[string]any{
			"id": text, "name": text, "prompt": text, "expected": text, "tags": strings,
			"models": map[string]any{"type": "array", "nullable": true, "items": text}, "run": map[string]any{"type": "boolean", "default": false},
		}),
		"GoldenPromptWriteResponse": object([]string{"golden_prompt", "results"}, map[string]any{
			"golden_prompt": schemaRef("GoldenPrompt"), "results": array("GoldenPromptResult"),
		}),
		"GoldenWorkflowWriteBody": object([]string{"name", "steps"}, map[string]any{
			"id": text, "name": text, "description": text, "tags": strings, "steps": array("GoldenWorkflowStepInput"),
			"created_at": text, "updated_at": text,
		}),
		"GoldenWorkflowStepInput": map[string]any{
			"type": "object", "properties": stepFields,
			"description": "Input fields are optional. Steps with an absent or blank prompt are discarded; the workflow must retain at least one nonblank prompt.",
		},
		"GoldenPrompt": object([]string{"id", "name", "prompt", "expected", "tags", "created_at", "updated_at"}, map[string]any{
			"id": text, "name": text, "prompt": text, "expected": text, "tags": strings, "created_at": text, "updated_at": text,
		}),
		"GoldenPromptResult": object([]string{"id", "prompt_id", "model", "score", "passed", "cost_krw", "latency_ms", "response", "created_at"}, map[string]any{
			"id": text, "prompt_id": text, "model": text, "score": number, "passed": map[string]any{"type": "boolean"},
			"cost_krw": number, "latency_ms": map[string]any{"type": "integer", "format": "int64"}, "response": text, "created_at": text,
		}),
		"GoldenPromptListResponse": object([]string{"golden_prompts", "results"}, map[string]any{
			"golden_prompts": array("GoldenPrompt"), "results": array("GoldenPromptResult"),
			"run_revisions": schemaRef("GoldenRunRevisions"),
		}),
		"GoldenWorkflowStep": object([]string{"name", "prompt", "expected"}, stepFields),
		"GoldenWorkflow": object([]string{"id", "name", "description", "steps", "tags", "created_at", "updated_at"}, map[string]any{
			"id": text, "name": text, "description": text, "tags": strings, "created_at": text, "updated_at": text,
			"steps": map[string]any{"type": "array", "nullable": true, "items": schemaRef("GoldenWorkflowStep")},
		}),
		"GoldenWorkflowListResponse": object([]string{"workflows"}, map[string]any{"workflows": array("GoldenWorkflow"), "run_revisions": schemaRef("GoldenRunRevisions")}),
	}
}

func enrichGoldenWriteOpenAPI(key string, op, responses map[string]any) {
	op["description"] = "Existing admin:write definition upsert. No conditional revision or atomic audit guarantee. Response is the normalized input, not a persisted timestamp snapshot; read the registry after saving."
	if key == "post /admin/golden-prompts" {
		delete(responses, "200")
		op["description"] = op["description"].(string) + " Name and prompt are trimmed; expected and tags are preserved. Omitted/empty id generates an id. Supplying any models or run=true also executes models: definition-only clients must omit both fields. A save/run failure can occur after the definition was saved."
		op["requestBody"] = requestBody("GoldenPromptWriteBody")
		responses["201"] = successResponse("GoldenPromptWriteResponse")
	} else {
		op["description"] = op["description"].(string) + " Name, step names and step prompts are trimmed; empty-prompt steps are discarded and at least one must remain. Optional step provenance is preserved. Omitted/empty id generates an id. Definition upsert never executes models."
		op["requestBody"] = requestBody("GoldenWorkflowWriteBody")
		responses["200"] = successResponse("GoldenWorkflow")
	}
	for _, status := range []string{"400", "401", "405", "500"} {
		responses[status] = map[string]any{"description": "Existing validation, authorization, method or storage error", "content": jsonContent(schemaRef("AppError"))}
	}
}
