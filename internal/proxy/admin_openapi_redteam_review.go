package proxy

import (
	"sort"
	"strings"
)

func enrichRedTeamRunReviewOpenAPI(key string, op, responses map[string]any) {
	review := strings.HasSuffix(key, "/run-review")
	request, response := "RedTeamReviewedExecutionRequest", "RedTeamReviewedExecutionResponse"
	if review {
		request, response = "RedTeamRunReviewRequest", "RedTeamRunReviewResponse"
	}
	op["requestBody"] = requestBody(request)
	op["description"] = "Existing admin:write campaign runner, explicit live or simulation selection. A server-local, actor-bound review expires after five minutes and is consumed before admission audit or execution. Registered definitions and provider/runtime configuration are revalidated. Live model discovery and automatic routing aliases are disabled. The reviewed physical model identity is checked after routing; deprecation replacements and context-overflow retries to another model are refused. Maximum 200 model probes, requested output tokens per call 1..4096, sequential execution, at most 120 seconds. A positive KRW limit stops subsequent calls after measured/estimated cost reaches it; the last call can exceed it. Gateway internal retries and expanded input are not covered by probe/output-request counts. Text2SQL targets are simulation-only, like MCP/app/workflow targets. Live model names must be physical: Text2SQL, MCP discovery and enabled agent-route virtual models are rejected both during preparation and at their execution boundary. Nested generation/review/summary/shadow calls are not covered by this review. Current routing and security policies still apply; concurrent external configuration writes are not locked. Only reviewed runs of the same campaign on this Server are serialized; legacy/scheduled/other-server executions are not. Reviewed runs require acknowledged result/evidence/remediation bundles and atomic run/campaign/baseline finalization. Recording failures stop later calls and return recording.confirmed=false; complete requires confirmed storage. These acknowledgements are not whole-execution rollback, crash recovery or exactly-once model invocation. Never automatically replay or fall back to the legacy run endpoint after an uncertain response."
	responses["200"] = successResponse(response)
	for _, status := range []string{"400", "401", "403", "404", "409", "500", "503"} {
		responses[status] = map[string]any{"description": "Review rejected or outcome unknown; read current history before a new review", "content": jsonContent(schemaRef("AppError"))}
	}
}
func redTeamRunReviewOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	amount := map[string]any{"type": "number", "minimum": 0}
	boolean := map[string]any{"type": "boolean"}
	object := func(p map[string]any) map[string]any {
		required := make([]string, 0, len(p))
		for k := range p {
			required = append(required, k)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": p}
	}
	array := func(items map[string]any) map[string]any { return map[string]any{"type": "array", "items": items} }
	kind := map[string]any{"type": "string", "enum": []string{"live", "simulation"}}
	token := map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_-]{43}$"}
	models := map[string]any{"type": "array", "maxItems": 200, "uniqueItems": true, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 256, "description": "Exact trimmed concrete model name; glob and newline characters are rejected"}}
	limits := object(map[string]any{"max_calls": map[string]any{"type": "integer", "minimum": 1, "maximum": 200}, "max_output_tokens": map[string]any{"type": "integer", "minimum": 1, "maximum": 4096}, "budget_limit_krw": map[string]any{"type": "number", "exclusiveMinimum": true, "minimum": 0, "maximum": 1000000}})
	response := map[string]any{"review_token": token, "review_id": text, "expires_at": map[string]any{"type": "string", "format": "date-time"}, "scope": map[string]any{"type": "string", "enum": []string{"responding_server"}}, "campaign_id": text, "campaign_name": text, "kind": kind, "reason": text, "targets": array(schemaRef("RedTeamReviewedTarget")), "probe_pack_ids": array(text), "limits": schemaRef("RedTeamRunLimits"), "planned_live_calls": count, "case_executions": count, "estimated_cost_krw": amount, "requested_output_tokens": count, "registered_input_bytes": count, "timeout_ms": count, "retain_raw_evidence": boolean}
	run := map[string]any{}
	for _, name := range []string{"id", "campaign_id", "target_id", "started_at", "ended_at", "status", "mode", "created_at"} {
		run[name] = text
	}
	for _, name := range []string{"total_cases", "failed_cases", "risk_score"} {
		run[name] = count
	}
	run["cost_krw"] = amount
	summary := map[string]any{"mode": text, "live_cost_krw": amount}
	for _, name := range []string{"runs", "results", "warnings", "failures", "critical", "live_calls"} {
		summary[name] = count
	}
	execution := map[string]any{"campaign_id": text, "status": map[string]any{"type": "string", "enum": []string{"completed", "stopped"}}, "stopped": text, "runs": array(object(run)), "summary": object(summary), "note": text, "review_id": text, "execution_kind": kind, "limits": schemaRef("RedTeamRunLimits"), "planned_live_calls": count, "planned_case_executions": count, "complete": boolean, "recording": schemaRef("RedTeamRecording")}
	body := object(map[string]any{"review_token": token, "proxy_key": map[string]any{"type": "string", "maxLength": 8192}})
	body["required"] = []string{"review_token"}
	return map[string]any{
		"RedTeamRecording":                 object(map[string]any{"confirmed": boolean, "stage": map[string]any{"type": "string", "enum": []string{"", "run_start", "case_result", "finalize"}}, "results": count}),
		"RedTeamRunLimits":                 limits,
		"RedTeamRunReviewRequest":          object(map[string]any{"kind": kind, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1000}, "models": models, "limits": schemaRef("RedTeamRunLimits")}),
		"RedTeamReviewedTarget":            object(map[string]any{"id": text, "target_ref": text, "provider": text, "models": models, "live_calls": count, "case_executions": count}),
		"RedTeamRunReviewResponse":         object(response),
		"RedTeamReviewedExecutionRequest":  body,
		"RedTeamReviewedExecutionResponse": object(execution),
	}
}
