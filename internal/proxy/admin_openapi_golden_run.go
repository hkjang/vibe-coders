package proxy

import "strings"

func enrichGoldenRunOpenAPI(key string, op, responses map[string]any) {
	op["description"] = "Existing admin:write model execution. Optional review validates exact definition hashes before any model call, limits calls to 1..64 and requested output tokens per call to 1..4096, forces one completion, and stops further calls after cancellation or a 120 second deadline. Output-token requests are not a monetary cap or guarantee of provider enforcement. Definition snapshots are used after validation; there is no global idempotency or atomic audit guarantee. Omitted review preserves legacy behavior."
	reviewed := strings.HasSuffix(key, "-reviewed")
	if reviewed {
		op["description"] = "Mandatory reviewed execution using the existing admin:write runner. Exact definition hashes, maximum 64 calls, requested output tokens 1..4096, one completion and a 120 second deadline are checked. Missing/null review is rejected before model calls. This distinct path prevents an older pod from silently ignoring new limits; never fall back to the legacy run path. Output-token requests are not a monetary cap or guarantee of provider enforcement. There is no global idempotency or atomic audit guarantee."
	}
	op["parameters"] = []any{map[string]any{"name": "fail_on_regression", "in": "query", "required": false, "schema": map[string]any{"type": "string", "enum": []string{"1"}}, "description": "Return 422 with the normal result body on a regression, or on an incomplete reviewed execution."}}
	response := "GoldenPromptRunResponse"
	if strings.Contains(key, "/golden-prompts/") {
		op["requestBody"] = requestBody("GoldenPromptRunBody")
		op["description"] = op["description"].(string) + " Optional prompt_ids select exact IDs; omitted/empty selects the registry. Tag further filters selection. Prompt results are stored best-effort; reviewed responses report results_saved."
		if reviewed {
			op["requestBody"] = requestBody("GoldenPromptReviewedRunBody")
			op["description"] = strings.ReplaceAll(op["description"].(string), "Optional prompt_ids select exact IDs; omitted/empty selects the registry.", "Nonempty prompt_ids select exact IDs.")
		}
	} else {
		op["requestBody"] = requestBody("GoldenWorkflowRunBody")
		response = "GoldenWorkflowRunResponse"
		if reviewed {
			op["requestBody"] = requestBody("GoldenWorkflowReviewedRunBody")
		}
		op["description"] = op["description"].(string) + " Workflow steps are independent prompts executed for each selected model; outputs are not chained. Workflow-run results are returned only, not persisted as run history."
	}
	responses["200"] = successResponse(response)
	responses["422"] = successResponse(response)
	for _, status := range []string{"400", "401", "404", "405", "409", "500"} {
		responses[status] = map[string]any{"description": "Validation, authorization, changed review or lookup failure before execution", "content": jsonContent(schemaRef("AppError"))}
	}
}

func goldenRunOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer", "minimum": 0}
	number := map[string]any{"type": "number"}
	boolean := map[string]any{"type": "boolean"}
	texts := map[string]any{"type": "array", "items": text}
	object := func(required []string, fields map[string]any) map[string]any {
		return map[string]any{"type": "object", "required": required, "properties": fields}
	}
	array := func(name string) map[string]any { return map[string]any{"type": "array", "items": schemaRef(name)} }
	bodyFields := func() map[string]any {
		return map[string]any{"models": texts, "min_pass_rate": map[string]any{"type": "number", "nullable": true}, "review": map[string]any{"allOf": []any{schemaRef("GoldenRunReview")}, "nullable": true}}
	}
	promptBody := bodyFields()
	promptBody["prompt_ids"] = map[string]any{"type": "array", "items": text, "nullable": true}
	promptBody["tag"] = map[string]any{"type": "string", "nullable": true}
	workflowBody := bodyFields()
	workflowBody["id"] = text
	promptReviewed := bodyFields()
	promptReviewed["review"] = schemaRef("GoldenRunReview")
	promptReviewed["prompt_ids"] = map[string]any{"type": "array", "items": text, "minItems": 1, "maxItems": 64, "uniqueItems": true}
	workflowReviewed := bodyFields()
	workflowReviewed["review"], workflowReviewed["id"] = schemaRef("GoldenRunReview"), text
	responseFields := func() map[string]any {
		return map[string]any{
			"total": integer, "passed": integer, "failed": integer, "pass_rate": number, "min_pass_rate": number, "regressed": boolean,
			"planned_total": integer, "complete": boolean, "max_output_tokens": integer, "timeout_seconds": integer,
		}
	}
	promptResponse := responseFields()
	promptResponse["results"] = array("GoldenPromptResult")
	promptResponse["failures"] = array("GoldenPromptRunFailure")
	promptResponse["execution_errors"] = map[string]any{"type": "object", "additionalProperties": text}
	promptResponse["results_saved"] = boolean
	workflowResponse := responseFields()
	workflowResponse["workflow_id"], workflowResponse["workflow_name"] = text, text
	workflowResponse["steps"] = array("GoldenWorkflowRunStep")
	workflowResponse["failures"] = array("GoldenWorkflowRunFailure")
	step := map[string]any{"step": integer, "name": text, "model": text, "score": number, "passed": boolean, "cost_krw": number, "latency_ms": integer, "error": text}
	summary := []string{"total", "passed", "failed", "pass_rate", "min_pass_rate", "regressed"}
	return map[string]any{
		"GoldenRunRevisions": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}},
		"GoldenRunReview": object([]string{"definitions", "max_calls", "max_output_tokens"}, map[string]any{
			"definitions":       schemaRef("GoldenRunRevisions"),
			"max_calls":         map[string]any{"type": "integer", "minimum": 1, "maximum": goldenReviewedMaxCalls},
			"max_output_tokens": map[string]any{"type": "integer", "minimum": 1, "maximum": goldenReviewedMaxOutputTokens},
		}),
		"GoldenPromptRunBody":           object([]string{"models"}, promptBody),
		"GoldenWorkflowRunBody":         object([]string{"id", "models"}, workflowBody),
		"GoldenPromptReviewedRunBody":   object([]string{"models", "prompt_ids", "review"}, promptReviewed),
		"GoldenWorkflowReviewedRunBody": object([]string{"id", "models", "review"}, workflowReviewed),
		"GoldenPromptRunFailure":        object([]string{"prompt_id", "name", "model", "score"}, map[string]any{"prompt_id": text, "name": text, "model": text, "score": number}),
		"GoldenWorkflowRunFailure":      object([]string{"step", "name", "model", "score"}, map[string]any{"step": integer, "name": text, "model": text, "score": number}),
		"GoldenWorkflowRunStep":         object([]string{"step", "name", "model", "score", "passed", "cost_krw", "latency_ms"}, step),
		"GoldenPromptRunResponse":       object(append(append([]string{}, summary...), "results", "failures"), promptResponse),
		"GoldenWorkflowRunResponse":     object(append(append([]string{}, summary...), "workflow_id", "workflow_name", "steps", "failures"), workflowResponse),
	}
}
