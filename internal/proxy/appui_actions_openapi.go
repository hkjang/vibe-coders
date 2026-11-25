package proxy

import "vibe-coders/internal/store"

func appUIActionOpenAPISchemas() map[string]any {
	feature := map[string]any{"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$"}
	action := map[string]any{"type": "string", "enum": store.AppUIActionKinds()}
	version := map[string]any{"type": "string", "maxLength": 32, "pattern": "^(v(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5}))?$"}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": store.AppUIActionLimit}
	counts := map[string]any{"success": count, "rejected": count, "unknown": count}
	group := map[string]any{"feature_id": feature, "action": action, "ui_version": version, "success": count, "rejected": count, "unknown": count}
	return map[string]any{
		"UIActionEventRequest": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"event_id", "feature_id", "action", "outcome"}, "properties": map[string]any{
			"event_id":   map[string]any{"type": "string", "pattern": "^[0-9a-f]{32}$", "minLength": 32, "maxLength": 32, "description": "Fresh random nonce, hashed by the server; never identity-derived or persisted by the browser."},
			"feature_id": feature, "action": action, "outcome": map[string]any{"type": "string", "enum": []string{"success", "rejected", "unknown"}},
		}},
		"UIActionCounts": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"success", "rejected", "unknown"}, "properties": counts},
		"UIActionGroup":  map[string]any{"type": "object", "additionalProperties": false, "required": []string{"feature_id", "action", "ui_version", "success", "rejected", "unknown"}, "properties": group},
		"UIActionSummaryResponse": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"enabled", "days", "from", "to", "retention_days", "event_limit", "group_limit", "success", "rejected", "unknown", "other", "groups"}, "properties": map[string]any{
			"enabled": map[string]any{"type": "boolean"}, "days": map[string]any{"type": "integer", "enum": []int{7, 30}}, "from": map[string]any{"type": "string", "format": "date-time"}, "to": map[string]any{"type": "string", "format": "date-time"},
			"retention_days": map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryRetentionDays}}, "event_limit": map[string]any{"type": "integer", "enum": []int{store.AppUIActionLimit}}, "group_limit": map[string]any{"type": "integer", "enum": []int{store.AppUIActionGroupLimit}},
			"success": count, "rejected": count, "unknown": count, "other": schemaRef("UIActionCounts"), "groups": map[string]any{"type": "array", "maxItems": store.AppUIActionGroupLimit, "items": schemaRef("UIActionGroup")},
		}},
	}
}

func enrichAppUIActionOpenAPI(method string, op, responses map[string]any) {
	if method == "post" {
		op["security"] = []any{map[string]any{}, map[string]any{"bearerAuth": []any{}}}
		op["description"] = "Optional, lossy browser-observed operation outcomes. Requires fresh shared-DB UI/telemetry opt-in, existing identity and feature permission. Shares process/caller intake quotas and a two-second cancellation/body-read budget. Strict 1024-byte JSON accepts only a random nonce, feature and fixed action/outcome categories. No payload, identity, path, request ID or message is retained. Numeric UI release comes from the standard header. Idempotent immutable nonce hash, 10000-event capacity, 30-day retention. Disabled, overloaded or full intake returns 204 without collecting; never retry. success means the operation handler acknowledged completion, run_request only means a job was accepted. rejected means explicit rejection; unknown is excluded from known-outcome success rates. This is not a whole-service success rate or business audit authority."
		op["requestBody"] = requestBody("UIActionEventRequest")
		delete(responses, "200")
		responses["204"] = map[string]any{"description": "Recorded idempotently or intentionally dropped; never retry"}
		responses["403"] = map[string]any{"description": "Feature access denied", "content": jsonContent(schemaRef("AppError"))}
		responses["503"] = map[string]any{"description": "Observation unavailable; never retry", "content": jsonContent(schemaRef("AppError"))}
	} else {
		op["description"] = "Requires admin read and current feature permissions. Returns a single snapshot, at most 100 groups and separate omitted-group outcome counts. Known-outcome rate is success/(success+rejected); unknown observations must be shown separately. Reports are anonymous, optional and incomplete, not population-wide action totals."
		op["parameters"] = []any{map[string]any{"name": "days", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "enum": []int{7, 30}, "default": 7}}}
		responses["200"] = successResponse("UIActionSummaryResponse")
	}
}
