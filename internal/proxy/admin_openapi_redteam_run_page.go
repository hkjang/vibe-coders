package proxy

import "slices"

func enrichRedTeamRunPageOpenAPI(op, responses map[string]any) {
	op["description"] = "Existing admin:read run history. Without view, returns the unchanged latest-100 runs/count response. Opt-in view=page returns count and bounded rows from one database snapshot, with exact identifier, status, mode, kind and half-open RFC3339 from/to filters applied before pagination. Both time bounds are required together. Sort accepts at most three unique field:asc|desc pairs from created_at,id,status,total_cases,failed_cases,risk_score,cost_krw; default created_at:desc, id:desc breaks ties. UTC timestamps sort at nanosecond precision. kind=replay selects source_result_id present, kind=campaign selects absent. Page responses never include result, prompt or evidence bodies. Unknown/duplicate/malformed parameters and credential-shaped identifiers are rejected without echo. Responses are no-store. Separate page requests may reflect new or updated runs."
	params := []any{}
	for _, field := range []struct {
		name   string
		schema map[string]any
	}{
		{"view", map[string]any{"type": "string", "enum": []string{"page"}}},
		{"limit", map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
		{"offset", map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}},
		{"status", map[string]any{"type": "string", "enum": []string{"running", "passed", "failed", "warning", "stopped"}}},
		{"mode", map[string]any{"type": "string", "enum": []string{"dry-run", "active-controlled"}}},
		{"kind", map[string]any{"type": "string", "enum": []string{"campaign", "replay"}}},
		{"sort", map[string]any{"type": "string", "maxLength": 100}},
	} {
		params = append(params, map[string]any{"name": field.name, "in": "query", "schema": field.schema})
	}
	for _, name := range []string{"run_id", "campaign_id", "source_result_id", "review_id"} {
		params = append(params, map[string]any{"name": name, "in": "query", "schema": map[string]any{"type": "string", "maxLength": 256}})
	}
	for _, name := range []string{"from", "to"} {
		params = append(params, map[string]any{"name": name, "in": "query", "schema": map[string]any{"type": "string", "format": "date-time"}})
	}
	op["parameters"] = params
	responses["200"] = map[string]any{"description": "Legacy run list or explicit page", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("RedTeamRunLegacyList"), schemaRef("RedTeamRunPage")}})}
	for _, code := range []string{"400", "401", "403", "405", "503"} {
		responses[code] = map[string]any{"description": "Query, authorization or storage error", "content": jsonContent(schemaRef("AppError"))}
	}
}

func redTeamRunPageOpenAPISchemas() map[string]any {
	object := func(fields map[string]any) map[string]any {
		required := []string{}
		for name := range fields {
			required = append(required, name)
		}
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer", "minimum": 0}
	fields := map[string]any{"id": text, "campaign_id": text, "target_id": text, "started_at": text, "ended_at": text, "status": text, "mode": text, "created_at": text, "total_cases": count, "failed_cases": count, "risk_score": count, "cost_krw": map[string]any{"type": "number", "minimum": 0}}
	run := object(fields)
	// Provenance was added later; original campaign runs omit these fields.
	fields["source_result_id"], fields["review_id"] = text, text
	rows := map[string]any{"type": "array", "items": schemaRef("RedTeamRunMetadata")}
	return map[string]any{
		"RedTeamRunMetadata":   run,
		"RedTeamRunLegacyList": object(map[string]any{"runs": rows, "count": count}),
		"RedTeamRunPage":       object(map[string]any{"runs": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("RedTeamRunMetadata")}, "total": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "offset": count, "generated_at": map[string]any{"type": "string", "format": "date-time"}}),
	}
}
