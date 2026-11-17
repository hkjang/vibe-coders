package proxy

func enrichRedTeamEmergencyOpenAPI(method string, op, responses map[string]any) {
	responses["200"] = successResponse("RedTeamEmergencyState")
	responses["503"] = map[string]any{"description": "redteam_review_unavailable: no safe review token could be prepared; no change applied", "content": jsonContent(schemaRef("AppError"))}
	op["description"] = "No-store, responding-process Red Team admission control. Not cluster-wide or durable: restart clears the state. Already dispatched upstream calls and other processes are not cancelled. New campaigns, scheduler/post-change starts and subsequent case admissions observe the flag. The opaque review_token is valid only for this process and state revision; every accepted legacy or reviewed write invalidates it, including no-ops and A-B-A changes."
	if method == "get" {
		return
	}
	op["description"] = op["description"].(string) + " Supply expected_review_token with an explicit enabled boolean and nonblank reason (at most 1000 Unicode code points) for a reviewed change. Stale/cross-process review returns409 without applying or auditing a change. The admin audit is confirmed before the in-memory store; an audit acknowledgment failure returns500 and does not apply the flag, but can leave an audit record. This is not a durable flag/audit transaction; a process crash can occur between audit and memory application. Do not automatically replay any uncertain response. Legacy omitted/null enabled remains false; omitted/null expected_review_token preserves unguarded legacy behavior."
	op["requestBody"] = requestBody("RedTeamEmergencyChangeRequest")
	for code, description := range map[string]string{
		"400": "invalid_body or redteam_review_required: reviewed changes require an explicit state, nonempty reason and 32-character review token",
		"409": "redteam_review_conflict: reviewed process or state revision changed",
		"500": "redteam_kill_audit_failed: audit acknowledgment failed; flag not applied; read and review again, never blindly replay",
	} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func redTeamEmergencyOpenAPISchemas() map[string]any {
	return map[string]any{
		"RedTeamEmergencyState": map[string]any{
			"type": "object", "required": []string{"enabled", "scope", "instance_ref", "review_token", "observed_at"},
			"properties": map[string]any{
				"enabled":      map[string]any{"type": "boolean"},
				"scope":        map[string]any{"type": "string", "enum": []string{"responding_process"}},
				"instance_ref": map[string]any{"type": "string", "pattern": "^process_[a-f0-9]{16}$"},
				"review_token": map[string]any{"type": "string", "pattern": "^[a-f0-9]{32}$"},
				"observed_at":  map[string]any{"type": "string", "format": "date-time"},
				"reason":       map[string]any{"type": "string", "description": "Trimmed reason echoed only in the change acknowledgment, not stored in process memory for GET"},
			},
		},
		"RedTeamEmergencyChangeRequest": map[string]any{
			"type": "object", "nullable": true,
			"properties": map[string]any{
				"enabled":               map[string]any{"type": "boolean", "nullable": true},
				"reason":                map[string]any{"type": "string", "nullable": true, "maxLength": 1000},
				"expected_review_token": map[string]any{"type": "string", "nullable": true, "minLength": 32, "maxLength": 32},
			},
		},
	}
}
