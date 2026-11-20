package proxy

import "vibe-coders/internal/store"

func appUIDiagnosticOpenAPISchemas() map[string]any {
	featureID := map[string]any{"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$"}
	nonce := map[string]any{"type": "string", "minLength": 32, "maxLength": 32, "pattern": "^[0-9a-f]{32}$", "description": "Fresh cryptographically random event nonce; retained only as a hash; never identity-derived or persisted in browser storage."}
	requestID := map[string]any{"type": "string", "maxLength": 64, "description": "Only trace_ followed by 32 lowercase hex characters is retained; any other identifier is discarded before storage."}
	endpoint := map[string]any{"type": "string", "minLength": 1, "maxLength": 256, "description": "Exact registered OpenAPI path template, never resolved identifiers, a query string or full URL. Auth and observation endpoints are excluded."}
	method := map[string]any{"type": "string", "enum": []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}}
	status := map[string]any{"type": "integer", "minimum": 0, "maximum": 599, "description": "0 when no response; otherwise an HTTP status between 100 and 599."}
	apiFailure := map[string]any{"type": "string", "enum": []string{"http", "auth", "permission", "contract", "network", "timeout"}}
	jsFailure := map[string]any{"type": "string", "enum": []string{"error", "type", "range", "reference", "syntax", "uri", "eval", "aggregate", "unknown"}}
	boundary := map[string]any{"type": "string", "enum": []string{"root", "route"}}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": store.AppUIDiagnosticLimit}
	common := map[string]any{
		"feature_id": featureID, "kind": map[string]any{"type": "string", "enum": []string{"api_error", "js_error"}},
		"ui_version": map[string]any{"type": "string", "maxLength": 32, "pattern": "^(v(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5}))?$"},
		"endpoint":   map[string]any{"type": "string", "maxLength": 256}, "method": map[string]any{"type": "string", "enum": []string{"", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}},
		"status": status, "request_id": map[string]any{"type": "string", "pattern": "^(trace_[0-9a-f]{32})?$"},
		"failure":  map[string]any{"type": "string", "enum": []string{"http", "auth", "permission", "contract", "network", "timeout", "error", "type", "range", "reference", "syntax", "uri", "eval", "aggregate", "unknown"}},
		"boundary": map[string]any{"type": "string", "enum": []string{"", "root", "route"}},
	}
	required := []string{"feature_id", "kind", "ui_version", "endpoint", "method", "status", "request_id", "failure", "boundary"}
	group := map[string]any{}
	recent := map[string]any{}
	for key, value := range common {
		group[key] = value
		recent[key] = value
	}
	group["events"] = count
	recent["received_at"] = map[string]any{"type": "string", "format": "date-time"}
	return map[string]any{
		"UIDiagnosticEventRequest": map[string]any{"oneOf": []any{
			map[string]any{"type": "object", "additionalProperties": false, "required": []string{"event_id", "feature_id", "kind", "endpoint", "method", "status", "failure"}, "properties": map[string]any{"event_id": nonce, "feature_id": featureID, "kind": map[string]any{"type": "string", "enum": []string{"api_error"}}, "endpoint": endpoint, "method": method, "status": status, "request_id": requestID, "failure": apiFailure}},
			map[string]any{"type": "object", "additionalProperties": false, "required": []string{"event_id", "feature_id", "kind", "boundary", "failure"}, "properties": map[string]any{"event_id": nonce, "feature_id": featureID, "kind": map[string]any{"type": "string", "enum": []string{"js_error"}}, "boundary": boundary, "failure": jsFailure}},
		}},
		"UIDiagnosticGroup":  map[string]any{"type": "object", "additionalProperties": false, "required": append(append([]string{}, required...), "events"), "properties": group},
		"UIDiagnosticRecent": map[string]any{"type": "object", "additionalProperties": false, "required": append(append([]string{}, required...), "received_at"), "properties": recent},
		"UIDiagnosticSummaryResponse": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"enabled", "days", "from", "to", "retention_days", "event_limit", "group_limit", "recent_limit", "total", "other_group_events", "groups", "recent"}, "properties": map[string]any{
			"enabled": map[string]any{"type": "boolean"}, "days": map[string]any{"type": "integer", "enum": []int{7, 30}}, "from": map[string]any{"type": "string", "format": "date-time"}, "to": map[string]any{"type": "string", "format": "date-time"},
			"retention_days": map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryRetentionDays}}, "event_limit": map[string]any{"type": "integer", "enum": []int{store.AppUIDiagnosticLimit}}, "group_limit": map[string]any{"type": "integer", "enum": []int{store.AppUIDiagnosticGroupLimit}}, "recent_limit": map[string]any{"type": "integer", "enum": []int{store.AppUIDiagnosticRecentLimit}},
			"total": count, "other_group_events": count, "groups": map[string]any{"type": "array", "maxItems": store.AppUIDiagnosticGroupLimit, "items": schemaRef("UIDiagnosticGroup")}, "recent": map[string]any{"type": "array", "maxItems": store.AppUIDiagnosticRecentLimit, "items": schemaRef("UIDiagnosticRecent")},
		}},
	}
}

func enrichAppUIDiagnosticOpenAPI(method string, op, responses map[string]any) {
	if method == "post" {
		op["security"] = []any{map[string]any{}, map[string]any{"bearerAuth": []any{}}}
		op["description"] = "Opt-in, lossy UI error observations. Reuses fresh shared-DB UI/telemetry flags, existing identity and feature access, process/caller intake quotas and two-second cancellation/body-read budgets. Body is limited to 1024 bytes. Strict schema rejects duplicate/unknown/case-variant keys. Only registered endpoint templates, error classifications, HTTP status, numeric UI release and gateway-shaped request IDs are retained. No messages, stacks, raw URLs, payloads or identity. Event nonces are hashed and idempotent. At most 10000 observations for 30 days; disabled/overloaded/full intake returns 204 without collection or retry. This is not a complete error log or integrity guarantee."
		op["requestBody"] = requestBody("UIDiagnosticEventRequest")
		delete(responses, "200")
		responses["204"] = map[string]any{"description": "Recorded idempotently or intentionally dropped; never retry"}
		responses["403"] = map[string]any{"description": "Feature access denied", "content": jsonContent(schemaRef("AppError"))}
		responses["503"] = map[string]any{"description": "Observation unavailable; never retry", "content": jsonContent(schemaRef("AppError"))}
	} else {
		op["description"] = "Requires admin read and current feature permissions. Returns at most 100 error groups and 20 recent safe correlations from one snapshot. Historical observations remain readable while collection is off. Counts are incomplete and exclude initial bootstrap, stale sessions, canceled requests, auth endpoints and observation requests themselves."
		op["parameters"] = []any{map[string]any{"name": "days", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "enum": []int{7, 30}, "default": 7}}}
		responses["200"] = successResponse("UIDiagnosticSummaryResponse")
	}
}
