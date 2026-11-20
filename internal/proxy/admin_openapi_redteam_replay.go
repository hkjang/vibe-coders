package proxy

import (
	"maps"
	"sort"
	"strings"
)

func enrichRedTeamReplayOpenAPI(key string, op, responses map[string]any) {
	enrichRedTeamRunReviewOpenAPI(key, op, responses)
	request, response := "RedTeamReviewedExecutionRequest", "RedTeamReplayExecutionResponse"
	if strings.HasSuffix(key, "/rerun-review") {
		request, response = "RedTeamReplayReviewRequest", "RedTeamReplayReviewResponse"
	}
	op["requestBody"] = requestBody(request)
	responses["200"] = successResponse(response)
	op["description"] = "Existing admin:write single-case replay using the shared reviewed physical-model planner, call bounds and result/evidence transaction. Preparation performs no model call. Review binds the actor, original result/run/evidence identity, current case/pack/target/campaign, physical model, runtime configuration, explicit raw-retention choice and limits for five minutes on the responding Server. Campaign tokens cannot authorize replay and replay tokens cannot authorize campaigns or another result. Exactly one LLM probe is planned; Text2SQL/MCP/app/workflow replay is rejected until their multi-stage budget is supported. The original run/result/evidence remain unchanged. A new run permanently stores source_result_id and review_id, including when later recording fails. Admission audit is acknowledged before dispatch. Replay completion never changes campaign status or pack baselines. Output-token/time/cost constraints and gateway internal-retry limits are the same as reviewed campaigns; they do not promise an absolute provider billing cap or exactly-once invocation. Unknown outcomes must never automatically retry or fall back to the legacy rerun action."
}

func redTeamReplayOpenAPISchemas() map[string]any {
	base := redTeamRunReviewOpenAPISchemas()
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	amount := map[string]any{"type": "number", "minimum": 0}
	object := func(properties map[string]any) map[string]any {
		keys := make([]string, 0, len(properties))
		for key := range properties {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return map[string]any{"type": "object", "additionalProperties": false, "required": keys, "properties": properties}
	}
	properties := func(schema any) map[string]any {
		return maps.Clone(schema.(map[string]any)["properties"].(map[string]any))
	}
	limits := properties(base["RedTeamRunLimits"])
	limits["max_calls"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 1}
	source := map[string]any{}
	for _, key := range []string{"id", "run_id", "case_id", "request_id", "decision", "severity", "evidence_hash", "policy_decision", "created_at"} {
		source[key] = text
	}
	source["latency_ms"], source["cost_krw"] = count, amount
	review := properties(base["RedTeamRunReviewResponse"])
	delete(review, "job_id")
	review["source_result"], review["case_key"], review["pack_name"] = object(source), text, text
	review["kind"] = map[string]any{"type": "string", "enum": []string{"live"}}
	execution := properties(base["RedTeamReviewedExecutionResponse"])
	execution["source_result_id"], execution["source_run_id"] = text, text
	run := properties(execution["runs"].(map[string]any)["items"])
	run["source_result_id"], run["review_id"] = text, text
	execution["runs"] = map[string]any{"type": "array", "maxItems": 1, "items": object(run)}
	execution["execution_kind"] = map[string]any{"type": "string", "enum": []string{"live"}}
	return map[string]any{
		"RedTeamReplayReviewRequest":     object(map[string]any{"reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1000}, "model": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}, "limits": object(limits), "retain_raw_evidence": map[string]any{"type": "boolean"}}),
		"RedTeamReplayReviewResponse":    object(review),
		"RedTeamReplayExecutionResponse": object(execution),
	}
}
