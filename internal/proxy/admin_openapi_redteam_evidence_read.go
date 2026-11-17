package proxy

import "slices"

func enrichRedTeamEvidenceReadOpenAPI(op, responses map[string]any, evidence bool) {
	op["parameters"] = []any{map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"app"}}}}
	if evidence {
		op["description"] = "Existing admin:read evidence. Legacy full-admin response remains unchanged; all lower raw-view roles receive only stored masked text and allowlisted metadata, never original fallback, tool arguments, seed templates or arbitrary headers. Opt-in view=app is masked by default for every role, with raw_allowed from the existing canViewRawPrompts capability and raw_available describing retained originals/tool calls. view=app&reveal=raw requires that capability and a confirmed redteam.evidence.raw_view audit before returning originals. Audit contains only result/evidence ids and actor, not bodies. Missing masked captures stay empty. Structured metadata is allowlisted in app mode even for raw viewers; tool bodies are returned only by explicit raw reveal. All evidence responses are no-store. Unknown/duplicate/malformed app parameters are rejected; raw reveal without view=app is invalid. No model call or replay is performed."
		op["parameters"] = append(op["parameters"].([]any), map[string]any{"name": "reveal", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"raw"}}})
		responses["200"] = map[string]any{"description": "Legacy evidence or explicit app projection", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("RedTeamEvidenceLegacyRead"), schemaRef("RedTeamEvidenceRead")}})}
	} else {
		op["description"] = "Existing admin:read results, count and prompt previews. Legacy full-admin previews keep their original masked-then-raw fallback. Lower raw-view roles and opt-in view=app use only stored masked prompts, reapplying current credential projection; missing masked captures stay empty. App mode adds masked=true and rejects unknown/duplicate/malformed query parameters. It never bulk-reveals originals. Responses are no-store."
		responses["200"] = map[string]any{"description": "Legacy results or explicit app projection", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("RedTeamResultsLegacyRead"), schemaRef("RedTeamResultsRead")}})}
	}
	for _, code := range []string{"400", "401", "403", "404", "405", "500", "503"} {
		responses[code] = map[string]any{"description": "Read, permission or confirmed-audit failure", "content": jsonContent(schemaRef("AppError"))}
	}
}

func redTeamEvidenceReadOpenAPISchemas() map[string]any {
	object := func(fields map[string]any) map[string]any {
		required := []string{}
		for key := range fields {
			required = append(required, key)
		}
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "minimum": 0}
	record := map[string]any{"type": "object", "additionalProperties": true}
	fields := map[string]any{
		"id": text, "result_id": text, "masked_prompt": text, "masked_response": text,
		"tool_calls":      map[string]any{"type": "array", "items": record, "nullable": true},
		"headers_summary": map[string]any{"type": "object", "additionalProperties": true, "nullable": true},
		"export_hash":     text, "created_at": text,
	}
	evidence := object(fields)
	fields["raw_prompt"], fields["raw_response"] = text, text
	result := object(map[string]any{
		"id": text, "run_id": text, "case_id": text, "request_id": text, "decision": text, "severity": text,
		"evidence_hash": text, "policy_decision": text, "latency_ms": count, "cost_krw": map[string]any{"type": "number", "minimum": 0}, "created_at": text,
	})
	resultFields := map[string]any{"run": schemaRef("RedTeamRunMetadata"), "results": map[string]any{"type": "array", "items": schemaRef("RedTeamResultReadMetadata")}, "prompts": map[string]any{"type": "object", "additionalProperties": text}, "count": count}
	legacyResults := object(resultFields)
	appResultFields := map[string]any{}
	for key, value := range resultFields {
		appResultFields[key] = value
	}
	appResultFields["masked"] = map[string]any{"type": "boolean", "enum": []bool{true}}
	return map[string]any{
		"RedTeamEvidenceReadRecord": evidence,
		"RedTeamResultReadMetadata": result,
		"RedTeamEvidenceLegacyRead": object(map[string]any{"evidence": schemaRef("RedTeamEvidenceReadRecord")}),
		"RedTeamEvidenceRead":       object(map[string]any{"evidence": schemaRef("RedTeamEvidenceReadRecord"), "masked": flag, "raw_allowed": flag, "raw_available": flag, "tool_call_count": count}),
		"RedTeamResultsLegacyRead":  legacyResults,
		"RedTeamResultsRead":        object(appResultFields),
	}
}
