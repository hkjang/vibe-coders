package proxy

import "strings"

// OpenAPI contract for the dynamic route admin API (admin_dynamic_routes.go).

func enrichDynamicRoutesOpenAPI(key string, op, responses map[string]any) bool {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	invalidGraph := map[string]any{"description": "dynamic_route_graph_invalid: the graph has errors; validation lists them per element.", "content": jsonContent(schemaRef("DynamicRouteGraphRejection"))}
	if !strings.HasSuffix(key, dynamicRoutesAdminPath) && !strings.Contains(key, dynamicRoutesAdminPath+"/") {
		return false
	}
	responses["401"] = errorResponse("invalid_api_key: reading needs routing:read, writing routing:write. validate and simulate are reads.")
	switch key {
	case "get " + dynamicRoutesAdminPath:
		op["description"] = "Every dynamic route with its state and the last 24 hours of traffic. A client calls a route as the model \"dynamic/<name>\"."
		responses["200"] = successResponse("DynamicRouteListResponse")
	case "post " + dynamicRoutesAdminPath:
		op["description"] = "Create a route and its version 1. The route serves nothing until a version is deployed; deploy:true deploys version 1 at once. Names are lowercase letters, digits and . _ -."
		op["requestBody"] = requestBody("DynamicRouteCreateRequest")
		responses["201"] = successResponse("DynamicRouteWriteResponse")
		responses["400"] = errorResponse("invalid_body, dynamic_route_name_invalid or dynamic_route_graph_invalid (unreadable JSON).")
		responses["409"] = errorResponse("dynamic_route_name_taken.")
		responses["422"] = invalidGraph
	case "post " + dynamicRoutesAdminPath + "/validate":
		op["description"] = "Normalize and validate a graph. Errors block a save; warnings point at likely mistakes such as an unknown provider or a limit without a fallback. Nothing is stored."
		op["requestBody"] = requestBody("DynamicRouteValidateRequest")
		responses["200"] = successResponse("DynamicRouteValidateResponse")
	case "post " + dynamicRoutesAdminPath + "/simulate":
		op["description"] = "Walk a graph (inline, or a stored route version) for sample metadata and caller identity. failing marks model elements as failing so fallback chains can be checked; exceeded marks rate elements as spent. distribution repeats the walk with fresh randomness (sticky keys ignored) to show how percentage splits divide traffic. No model is called and no limit is consumed."
		op["requestBody"] = requestBody("DynamicRouteSimulateRequest")
		responses["200"] = successResponse("DynamicRouteSimulateResponse")
		responses["404"] = errorResponse("dynamic_route_not_found or dynamic_route_version_not_found.")
		responses["422"] = invalidGraph
	case "get " + dynamicRoutesAdminPath + "/{id}":
		op["description"] = "The route, its newest 100 versions (without graphs), the latest version's graph and, when a different version is deployed, the deployed graph."
		responses["200"] = successResponse("DynamicRouteDetailResponse")
		responses["404"] = errorResponse("dynamic_route_not_found.")
	case "patch " + dynamicRoutesAdminPath + "/{id}":
		op["description"] = "Change the description or turn the route off and on. Neither creates a version. A disabled route refuses calls with dynamic_route_disabled."
		op["requestBody"] = requestBody("DynamicRoutePatchRequest")
		responses["200"] = successResponse("DynamicRouteRouteResponse")
		responses["404"] = errorResponse("dynamic_route_not_found.")
	case "delete " + dynamicRoutesAdminPath + "/{id}":
		op["description"] = "Delete the route, its versions and its limit counters. Per-request history stays until retention purges the request logs."
		responses["200"] = successResponse("DynamicRouteDeleteResponse")
		responses["404"] = errorResponse("dynamic_route_not_found.")
	case "post " + dynamicRoutesAdminPath + "/{id}/versions":
		op["description"] = "Append a version on top of base_version, the latest version the edit started from. When another operator saved in between nothing is written (409). deploy:true also deploys the new version."
		op["requestBody"] = requestBody("DynamicRouteSaveVersionRequest")
		responses["201"] = successResponse("DynamicRouteWriteResponse")
		responses["404"] = errorResponse("dynamic_route_not_found.")
		responses["409"] = errorResponse("dynamic_route_conflict: the route changed since it was loaded.")
		responses["422"] = invalidGraph
	case "get " + dynamicRoutesAdminPath + "/{id}/versions/{version}":
		op["description"] = "One stored version with its graph and current validation."
		parameters, _ := op["parameters"].([]any)
		op["parameters"] = append(parameters, map[string]any{"name": "version", "in": "path", "required": true, "schema": map[string]any{"type": "integer", "minimum": 1}})
		responses["200"] = successResponse("DynamicRouteVersionResponse")
		responses["404"] = errorResponse("dynamic_route_version_not_found.")
	case "post " + dynamicRoutesAdminPath + "/{id}/deploy":
		op["description"] = "Make version the one serving traffic. Deploying an older version is the rollback. expected_deployed_version must match the currently deployed version (0 when none), so two operators cannot deploy over each other. The replica handling the call switches at once; other replicas within five seconds."
		op["requestBody"] = requestBody("DynamicRouteDeployRequest")
		responses["200"] = successResponse("DynamicRouteRouteResponse")
		responses["404"] = errorResponse("dynamic_route_not_found or dynamic_route_version_not_found.")
		responses["409"] = errorResponse("dynamic_route_conflict: a different version was deployed meanwhile.")
		responses["422"] = invalidGraph
	case "get " + dynamicRoutesAdminPath + "/{id}/activity":
		op["description"] = "Requests the route served, grouped by version, final element and outcome; the limit windows still open; and the newest 50 requests with their path. Stored metadata values are masked."
		op["parameters"] = []any{map[string]any{"name": "hours", "in": "query", "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 744, "default": 24}}}
		responses["200"] = successResponse("DynamicRouteActivityResponse")
		responses["404"] = errorResponse("dynamic_route_not_found.")
	default:
		return false
	}
	return true
}

func dynamicRoutesOpenAPISchemas() map[string]any {
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	text := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer"}
	number := map[string]any{"type": "number"}
	flag := map[string]any{"type": "boolean"}
	list := func(item map[string]any) map[string]any { return map[string]any{"type": "array", "items": item} }
	elementType := map[string]any{"type": "string", "enum": []string{"start", "conditional", "percentage", "rate", "model", "end"}}
	stateEnum := map[string]any{"type": "string", "enum": []string{"live", "live_with_draft", "not_deployed", "disabled"}}
	outcomeEnum := map[string]any{"type": "string", "enum": []string{"success", "cache_hit", "failed", "rate_limited", "no_model"}}
	graph := schemaRef("DynamicRouteGraph")
	return map[string]any{
		"DynamicRouteProperties": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
			"conditions": map[string]any{"type": "object", "additionalProperties": true, "description": "conditional: field paths (metadata.<key>, identity.*, request.*) mapped to a value or to operators $eq $ne $in $nin $gt $gte $lt $lte $exists; $and / $or combine objects."},
			"stickyKey":  map[string]any{"type": "string", "description": "percentage: field whose value keeps a caller in one branch."},
			"limitType":  map[string]any{"type": "string", "enum": []string{"count", "cost"}},
			"key":        map[string]any{"type": "string", "description": "rate: field each value of which gets its own limit; requests without it share one."},
			"limit":      map[string]any{"type": "number", "description": "rate: requests (count) or KRW (cost) per window."},
			"window":     map[string]any{"type": "integer", "minimum": dynamicRouteMinWindow, "maximum": dynamicRouteMaxWindow, "description": "rate: seconds."},
			"provider":   map[string]any{"type": "string", "description": "model: provider to pin; empty uses normal provider selection and same-model failover."},
			"model":      text,
			"timeout":    map[string]any{"type": "integer", "minimum": 0, "maximum": dynamicRouteMaxTimeoutMS, "description": "model: ms to wait for response headers per try; 0 keeps the provider timeout."},
			"retries":    map[string]any{"type": "integer", "minimum": 0, "maximum": dynamicRouteMaxRetries},
			"retryDelay": map[string]any{"type": "integer", "minimum": 0, "maximum": dynamicRouteMaxRetryDelay},
			"backoff":    map[string]any{"type": "string", "enum": []string{"constant", "linear", "exponential"}},
		}},
		"DynamicRouteOutput": object([]string{"elementId"}, map[string]any{"elementId": text}),
		"DynamicRouteElement": map[string]any{"type": "object", "additionalProperties": true, "required": []string{"id", "type"}, "properties": map[string]any{
			"id": text, "type": elementType, "label": text, "properties": schemaRef("DynamicRouteProperties"),
			"outputs": map[string]any{"type": "object", "additionalProperties": schemaRef("DynamicRouteOutput"), "description": "start: next; conditional: true/false; percentage: \"<n>%\"; rate and model: success/fallback."},
		}},
		"DynamicRouteGraph": map[string]any{"type": "object", "additionalProperties": true, "required": []string{"elements"}, "properties": map[string]any{
			"elements": map[string]any{"type": "array", "maxItems": dynamicRouteMaxElements, "items": schemaRef("DynamicRouteElement")},
		}, "description": "Cloudflare AI Gateway dynamic routing JSON. A whole exported route object is accepted; unused fields are dropped."},
		"DynamicRouteIssue":      object([]string{"code", "message"}, map[string]any{"element_id": text, "code": text, "message": text}),
		"DynamicRouteValidation": object([]string{"errors", "warnings"}, map[string]any{"errors": list(schemaRef("DynamicRouteIssue")), "warnings": list(schemaRef("DynamicRouteIssue"))}),
		"DynamicRouteTotals":     object([]string{"requests", "failures", "fallbacks"}, map[string]any{"requests": integer, "failures": integer, "fallbacks": integer}),
		"DynamicRoute": object([]string{"id", "name", "description", "enabled", "deployed_version", "latest_version", "created_by", "updated_by", "created_at", "updated_at", "call_model", "state", "traffic_24h"}, map[string]any{
			"id": text, "name": text, "description": text, "enabled": flag, "deployed_version": integer, "latest_version": integer,
			"deployed_at": text, "deployed_by": text, "created_by": text, "updated_by": text, "created_at": text, "updated_at": text,
			"call_model": text, "state": stateEnum, "traffic_24h": schemaRef("DynamicRouteTotals"),
		}),
		"DynamicRouteField":        object([]string{"field", "description"}, map[string]any{"field": text, "description": text}),
		"DynamicRouteListResponse": object([]string{"routes", "count", "fields"}, map[string]any{"routes": list(schemaRef("DynamicRoute")), "count": integer, "fields": list(schemaRef("DynamicRouteField"))}),
		"DynamicRouteCreateRequest": object([]string{"name", "graph"}, map[string]any{
			"name": map[string]any{"type": "string", "minLength": 1, "maxLength": 63}, "description": text, "enabled": flag,
			"graph": graph, "note": text, "deploy": flag,
		}),
		"DynamicRouteVersion": object([]string{"route_id", "version", "note", "created_by", "created_at"}, map[string]any{
			"route_id": text, "version": integer, "note": text, "created_by": text, "created_at": text,
			"graph": graph, "validation": schemaRef("DynamicRouteValidation"),
		}),
		"DynamicRouteWriteResponse": object([]string{"route", "validation"}, map[string]any{
			"route": schemaRef("DynamicRoute"), "graph": graph, "version": schemaRef("DynamicRouteVersion"), "validation": schemaRef("DynamicRouteValidation"),
		}),
		"DynamicRouteDetailResponse": object([]string{"route", "versions", "fields"}, map[string]any{
			"route": schemaRef("DynamicRoute"), "versions": list(schemaRef("DynamicRouteVersion")),
			"latest": schemaRef("DynamicRouteVersion"), "deployed": schemaRef("DynamicRouteVersion"), "fields": list(schemaRef("DynamicRouteField")),
		}),
		"DynamicRoutePatchRequest":       map[string]any{"type": "object", "additionalProperties": false, "minProperties": 1, "properties": map[string]any{"description": text, "enabled": flag}},
		"DynamicRouteRouteResponse":      object([]string{"route"}, map[string]any{"route": schemaRef("DynamicRoute")}),
		"DynamicRouteDeleteResponse":     object([]string{"id", "status"}, map[string]any{"id": text, "status": map[string]any{"type": "string", "enum": []string{"deleted"}}}),
		"DynamicRouteSaveVersionRequest": object([]string{"base_version", "graph"}, map[string]any{"base_version": integer, "graph": graph, "note": text, "deploy": flag}),
		"DynamicRouteVersionResponse":    object([]string{"version"}, map[string]any{"version": schemaRef("DynamicRouteVersion")}),
		"DynamicRouteDeployRequest": object([]string{"version", "expected_deployed_version"}, map[string]any{
			"version": map[string]any{"type": "integer", "minimum": 1}, "expected_deployed_version": map[string]any{"type": "integer", "minimum": 0}, "reason": text,
		}),
		"DynamicRouteStep": object([]string{"id", "type", "outcome"}, map[string]any{"id": text, "type": elementType, "outcome": text, "detail": text}),
		"DynamicRouteTrafficRow": object([]string{"version", "final_element_id", "final_model", "outcome", "requests", "fallbacks", "avg_latency_ms", "cost_krw"}, map[string]any{
			"version": integer, "final_element_id": text, "final_model": text, "outcome": text, "requests": integer, "fallbacks": integer, "avg_latency_ms": number, "cost_krw": number,
		}),
		"DynamicRouteLimitWindow": object([]string{"element_id", "scoped", "window_start", "window_end", "request_count", "cost_krw"}, map[string]any{
			"element_id": text, "scoped": flag, "window_start": text, "window_end": text, "request_count": integer, "cost_krw": number,
		}),
		"DynamicRouteRequestRecord": object([]string{"request_id", "route_id", "route_name", "version", "final_element_id", "final_model", "final_provider", "fallbacks", "attempts", "outcome", "status_code", "latency_ms", "cost_krw", "created_at", "steps", "metadata"}, map[string]any{
			"request_id": text, "route_id": text, "route_name": text, "version": integer, "final_element_id": text, "final_model": text,
			"final_provider": text, "provider_ref": text, "fallbacks": integer, "attempts": integer, "outcome": outcomeEnum,
			"status_code": integer, "latency_ms": integer, "cost_krw": number, "created_at": text,
			"steps": list(schemaRef("DynamicRouteStep")), "metadata": map[string]any{"type": "object", "additionalProperties": true, "description": "Masked metadata the request carried."},
		}),
		"DynamicRouteActivityResponse": object([]string{"route", "hours", "traffic", "limits", "requests"}, map[string]any{
			"route": schemaRef("DynamicRoute"), "hours": integer, "traffic": list(schemaRef("DynamicRouteTrafficRow")),
			"limits": list(schemaRef("DynamicRouteLimitWindow")), "requests": list(schemaRef("DynamicRouteRequestRecord")),
		}),
		"DynamicRouteValidateRequest":  object([]string{"graph"}, map[string]any{"graph": graph}),
		"DynamicRouteValidateResponse": object([]string{"valid", "graph", "validation"}, map[string]any{"valid": flag, "graph": graph, "validation": schemaRef("DynamicRouteValidation")}),
		"DynamicRouteSimulateRequest": object(nil, map[string]any{
			"route_id": text, "version": integer, "graph": graph,
			"metadata": map[string]any{"type": "object", "additionalProperties": true},
			"identity": map[string]any{"type": "object", "additionalProperties": text},
			"stream":   flag, "endpoint": text, "exceeded": list(text), "failing": list(text),
			"samples": map[string]any{"type": "integer", "minimum": 1, "maximum": 5000},
		}),
		"DynamicRouteSimulation": object([]string{"steps", "path", "outcome", "attempts", "fallbacks"}, map[string]any{
			"steps": list(schemaRef("DynamicRouteStep")), "path": text, "outcome": outcomeEnum, "final_element_id": text,
			"final_model": text, "provider": text, "attempts": integer, "fallbacks": integer, "blocked_by": text, "retry_after_seconds": integer,
		}),
		"DynamicRouteDistributionRow": object([]string{"final_element_id", "final_model", "outcome", "count", "share"}, map[string]any{
			"final_element_id": text, "final_model": text, "outcome": outcomeEnum, "count": integer, "share": number,
		}),
		"DynamicRouteSimulateResponse": object([]string{"result", "distribution", "samples", "validation"}, map[string]any{
			"result": schemaRef("DynamicRouteSimulation"), "distribution": list(schemaRef("DynamicRouteDistributionRow")),
			"samples": integer, "validation": schemaRef("DynamicRouteValidation"),
		}),
		"DynamicRouteGraphRejection": object([]string{"error", "validation"}, map[string]any{
			"error":      map[string]any{"type": "object", "additionalProperties": true},
			"validation": schemaRef("DynamicRouteValidation"),
		}),
	}
}
