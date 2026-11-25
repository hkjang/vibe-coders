package proxy

import "strings"

// OpenAPI contract for the DLP admin API (admin_dlp.go).

func enrichDLPOpenAPI(key string, op, responses map[string]any) bool {
	if !strings.Contains(key, dlpAdminPath) {
		return false
	}
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	invalid := map[string]any{"description": "dlp_config_invalid: the configuration has errors; issues lists them by path.", "content": jsonContent(schemaRef("DLPConfigRejection"))}
	responses["401"] = errorResponse("invalid_api_key: reading and the test scan need security:read; saving needs admin:write.")
	switch key {
	case "get " + dlpAdminPath:
		op["description"] = "The DLP configuration with its revision, the predefined profile and entry catalog (with synthetic examples), and a recommended starting set of policies. DLP inspects request text after authentication and before routing or caching, and response text before it reaches the client; matched values are never stored."
		responses["200"] = successResponse("DLPSettingsResponse")
	case "put " + dlpAdminPath:
		op["description"] = "Replace the configuration. expected_revision is the revision the edit started from (0 before the first save); another administrator's save in between returns 409 and nothing is written. The replica that saved applies it at once, others within five seconds."
		op["requestBody"] = requestBody("DLPSettingsWriteRequest")
		responses["200"] = successResponse("DLPSettingsWriteResponse")
		responses["400"] = errorResponse("invalid_body or dlp_revision_missing.")
		responses["409"] = errorResponse("dlp_conflict: the settings changed since they were loaded.")
		responses["422"] = invalid
	case "post " + dlpAdminPath + "/test":
		op["description"] = "Scan sample text with the saved configuration, or with config when given (an unsaved draft, which requires admin:write). Reports every profile that finds something with byte offsets into the text, what the request and response policies would decide for team_id/api_key_id, the masked request, and the response header value. DLP need not be enabled. Nothing is stored."
		op["requestBody"] = requestBody("DLPTestRequest")
		responses["200"] = successResponse("DLPTestResponse")
		responses["400"] = errorResponse("invalid_body or dlp_test_text_invalid.")
		responses["403"] = errorResponse("dlp_draft_forbidden: testing an unsaved configuration requires admin:write.")
		responses["422"] = invalid
	case "get " + dlpAdminPath + "/events":
		op["description"] = "Profiles that matched one side of one request, newest first, with partial previews (or only fingerprints, per settings) and a summary by action, side, profile and day. A team administrator sees only their team."
		op["parameters"] = []any{
			map[string]any{"name": "hours", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 2160, "default": 24}},
			map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 500, "default": 100}},
			map[string]any{"name": "action", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"FLAG", "MASK", "BLOCK"}}},
			map[string]any{"name": "check", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"REQUEST", "RESPONSE"}}},
			map[string]any{"name": "profile", "in": "query", "schema": map[string]any{"type": "string"}},
			map[string]any{"name": "request_id", "in": "query", "schema": map[string]any{"type": "string"}},
			map[string]any{"name": "team_id", "in": "query", "schema": map[string]any{"type": "string"}},
		}
		responses["200"] = successResponse("DLPEventsResponse")
		responses["400"] = errorResponse("dlp_events_query_invalid.")
	default:
		return false
	}
	return true
}

func dlpOpenAPISchemas() map[string]any {
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	text := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer"}
	flag := map[string]any{"type": "boolean"}
	list := func(item map[string]any) map[string]any { return map[string]any{"type": "array", "items": item} }
	confidence := map[string]any{"type": "string", "enum": []string{"low", "medium", "high"}}
	action := map[string]any{"type": "string", "enum": []string{"FLAG", "MASK", "BLOCK"}}
	check := map[string]any{"type": "string", "enum": []string{"REQUEST", "RESPONSE"}}
	return map[string]any{
		"DLPProfileSettings": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
			"disabled_entries": list(text), "min_confidence": confidence, "min_matches": map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
		}},
		"DLPCustomEntry": object([]string{"id", "name", "type"}, map[string]any{
			"id": text, "name": text, "type": map[string]any{"type": "string", "enum": []string{"regex", "keywords"}},
			"pattern": map[string]any{"type": "string", "maxLength": 512}, "keywords": list(text), "case_sensitive": flag,
			"confidence": confidence, "context": list(text), "mask": text,
		}),
		"DLPCustomProfile": object([]string{"id", "name", "entries"}, map[string]any{
			"id": text, "name": text, "description": text, "min_confidence": confidence,
			"min_matches": map[string]any{"type": "integer", "minimum": 0, "maximum": 100}, "entries": list(schemaRef("DLPCustomEntry")),
		}),
		"DLPPolicy": object([]string{"id", "enabled", "action", "profiles", "check"}, map[string]any{
			"id": text, "name": text, "enabled": flag, "action": action, "profiles": list(text), "check": list(check),
			"teams": list(text), "api_keys": list(text), "note": text,
		}),
		"DLPConfig": object([]string{"enabled", "evidence", "max_scan_bytes", "oversize", "profiles", "custom_profiles", "policies"}, map[string]any{
			"enabled":         flag,
			"evidence":        map[string]any{"type": "string", "enum": []string{"partial", "hash_only"}},
			"max_scan_bytes":  map[string]any{"type": "integer", "minimum": 1024, "maximum": 8 << 20},
			"oversize":        map[string]any{"type": "string", "enum": []string{"allow", "block"}},
			"profiles":        map[string]any{"type": "object", "additionalProperties": schemaRef("DLPProfileSettings")},
			"custom_profiles": list(schemaRef("DLPCustomProfile")),
			"policies":        list(schemaRef("DLPPolicy")),
		}),
		"DLPCatalogEntry": object([]string{"id", "name", "base_confidence", "requires_context", "context", "mask", "example"}, map[string]any{
			"id": text, "name": text, "description": text, "base_confidence": map[string]any{"type": "string", "enum": []string{"none", "low", "medium", "high"}},
			"requires_context": flag, "context": list(text), "mask": text, "example": text,
		}),
		"DLPCatalogProfile": object([]string{"id", "name", "description", "default_min_confidence", "default_min_matches", "entries"}, map[string]any{
			"id": text, "name": text, "description": text, "default_min_confidence": confidence, "default_min_matches": integer,
			"record_distinct": integer, "record_window": integer, "entries": list(schemaRef("DLPCatalogEntry")),
		}),
		"DLPSettingsResponse": object([]string{"config", "revision", "updated_by", "updated_at", "catalog", "recommended_policies", "response_header", "compat_header"}, map[string]any{
			"config": schemaRef("DLPConfig"), "revision": integer, "updated_by": text, "updated_at": text,
			"catalog": list(schemaRef("DLPCatalogProfile")), "recommended_policies": list(schemaRef("DLPPolicy")),
			"response_header": text, "compat_header": text,
		}),
		"DLPSettingsWriteRequest": object([]string{"config", "expected_revision"}, map[string]any{
			"config": schemaRef("DLPConfig"), "expected_revision": map[string]any{"type": "integer", "minimum": 0}, "reason": text,
		}),
		"DLPSettingsWriteResponse": object([]string{"config", "revision", "updated_by", "updated_at"}, map[string]any{
			"config": schemaRef("DLPConfig"), "revision": integer, "updated_by": text, "updated_at": text,
		}),
		"DLPIssue":           object([]string{"path", "message"}, map[string]any{"path": text, "message": text}),
		"DLPConfigRejection": object([]string{"error", "issues"}, map[string]any{"error": map[string]any{"type": "object", "additionalProperties": true}, "issues": list(schemaRef("DLPIssue"))}),
		"DLPTestRequest": object([]string{"text"}, map[string]any{
			"text": map[string]any{"type": "string", "minLength": 1}, "config": schemaRef("DLPConfig"), "team_id": text, "api_key_id": text,
		}),
		"DLPTestMatch": object([]string{"profile_id", "entry_id", "entry_name", "start", "end", "confidence"}, map[string]any{
			"profile_id": text, "entry_id": text, "entry_name": text, "start": integer, "end": integer, "confidence": confidence,
		}),
		"DLPTestProfile": object([]string{"profile_id", "name", "triggered", "match_count", "entry_ids"}, map[string]any{
			"profile_id": text, "name": text, "triggered": flag, "match_count": integer, "entry_ids": list(text),
		}),
		"DLPPolicyHit": object([]string{"policy_id", "action", "profiles"}, map[string]any{"policy_id": text, "action": action, "profiles": list(text)}),
		"DLPTestDecision": object([]string{"action", "policies"}, map[string]any{
			"action": map[string]any{"type": "string", "enum": []string{"", "FLAG", "MASK", "BLOCK"}}, "policies": list(schemaRef("DLPPolicyHit")),
		}),
		"DLPTestResponse": object([]string{"matches", "profiles", "truncated", "scanned_bytes", "request", "response", "masked_request", "header"}, map[string]any{
			"matches": list(schemaRef("DLPTestMatch")), "profiles": list(schemaRef("DLPTestProfile")), "truncated": flag, "scanned_bytes": integer,
			"request": schemaRef("DLPTestDecision"), "response": schemaRef("DLPTestDecision"), "masked_request": text, "header": text,
		}),
		"DLPEvent": object([]string{"id", "request_id", "api_key_id", "user_id", "team_id", "check", "action", "policy_ids", "profile_id", "entry_ids", "match_count", "confidence", "evidence", "hashes", "endpoint", "model", "created_at"}, map[string]any{
			"id": text, "request_id": text, "api_key_id": text, "user_id": text, "team_id": text, "check": check, "action": action,
			"policy_ids": list(text), "profile_id": text, "entry_ids": list(text), "match_count": integer, "confidence": text,
			"evidence": list(text), "hashes": list(text), "endpoint": text, "model": text, "created_at": text,
		}),
		"DLPEventCount": object([]string{"key", "events", "requests", "matches"}, map[string]any{"key": text, "events": integer, "requests": integer, "matches": integer}),
		"DLPEventsResponse": object([]string{"events", "summary", "hours", "count"}, map[string]any{
			"events": list(schemaRef("DLPEvent")),
			"summary": object([]string{"by_action", "by_check", "by_profile", "by_day"}, map[string]any{
				"by_action": list(schemaRef("DLPEventCount")), "by_check": list(schemaRef("DLPEventCount")),
				"by_profile": list(schemaRef("DLPEventCount")), "by_day": list(schemaRef("DLPEventCount")),
			}),
			"hours": integer, "count": integer,
		}),
	}
}
