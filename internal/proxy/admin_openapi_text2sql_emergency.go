package proxy

func enrichText2SQLEmergencyOpenAPI(method string, op, responses map[string]any) {
	responses["200"] = successResponse("Text2SQLEmergencyState")
	responses["503"] = map[string]any{"description": "text2sql_review_unavailable: no safe review token could be prepared; no change applied", "content": jsonContent(schemaRef("AppError"))}
	op["description"] = "No-store, responding-process Text2SQL admission control. Not cluster-wide or durable: restart clears the state. Already executing SQL and other processes are not cancelled. Disabled Text2SQL configuration remains disabled after resume. The opaque review_token is valid only for this process and state revision; every accepted legacy, reviewed or remediation write invalidates it, including no-ops and A-B-A changes. Configuration itself is not revision-guarded by this token."
	if method == "get" {
		return
	}
	op["description"] = op["description"].(string) + " Supply expected_review_token with an explicit disabled boolean and nonblank reason for a reviewed change. Stale/cross-process review returns409 without applying or auditing a change. The admin audit is confirmed before the in-memory store; an audit acknowledgment failure returns500 and does not apply the flag, but can leave an audit record. This is not a durable flag/audit transaction; a process crash can occur between audit and memory application. Do not automatically replay any uncertain response. Legacy omitted/null disabled remains false; omitted/null expected_review_token preserves unguarded legacy behavior."
	op["requestBody"] = requestBody("Text2SQLEmergencyChangeRequest")
	for code, description := range map[string]string{
		"400": "invalid_body or text2sql_review_required: reviewed changes require an explicit state, nonempty reason and 32-character review token",
		"409": "text2sql_review_conflict: reviewed process or state revision changed",
		"500": "text2sql_kill_audit_failed: audit acknowledgment failed; flag not applied; read and review again, never blindly replay",
	} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func text2SQLEmergencyOpenAPISchemas() map[string]any {
	return map[string]any{
		"Text2SQLEmergencyState": map[string]any{
			"type": "object", "required": []string{"disabled", "config_enabled", "scope", "instance_ref", "review_token", "observed_at"},
			"properties": map[string]any{
				"disabled":       map[string]any{"type": "boolean"},
				"config_enabled": map[string]any{"type": "boolean"},
				"scope":          map[string]any{"type": "string", "enum": []string{"responding_process"}},
				"instance_ref":   map[string]any{"type": "string", "pattern": "^process_[a-f0-9]{16}$"},
				"review_token":   map[string]any{"type": "string", "pattern": "^[a-f0-9]{32}$"},
				"observed_at":    map[string]any{"type": "string", "format": "date-time"},
				"reason":         map[string]any{"type": "string", "description": "Trimmed reason echoed only in the change acknowledgment, not stored in process memory for GET"},
			},
		},
		"Text2SQLEmergencyChangeRequest": map[string]any{
			"type": "object", "nullable": true,
			"properties": map[string]any{
				"disabled":              map[string]any{"type": "boolean", "nullable": true},
				"reason":                map[string]any{"type": "string", "nullable": true},
				"expected_review_token": map[string]any{"type": "string", "nullable": true, "minLength": 32, "maxLength": 32},
			},
		},
	}
}
