package proxy

import "sort"

func enrichIPUsageOpenAPI(route string, op, responses map[string]any) {
	op["description"] = "Existing admin:read API, with team-scoped aggregates for team administrators and existing prompt/metadata masking. All retained history; no time filter or server pagination. Responses are no-store. List returns at most 200 groups ordered by request count; this is not a gateway-wide total. Invalid legacy IPs can be filtered by caller permissions."
	name := "IPUsageList"
	if route == "/admin/ips/{ip}" {
		name = "IPUsageDetail"
		op["description"] = "Existing admin:read IP detail with the same team scope on every aggregate. Preserve the exact stored IPv4/IPv6 representation; unknown is the unrecorded-address group. Zones and invalid addresses are rejected. Daily data contains at most 60 active Asia/Seoul date buckets; model/key groups at most 50 each. No prompt or response body is needed by the new UI. Responses are no-store."
		op["parameters"] = []any{
			map[string]any{"name": "ip", "in": "path", "required": true, "schema": map[string]any{"type": "string", "maxLength": 128}, "description": "Exact stored IP address or unknown; URL-encode without canonicalizing."},
			map[string]any{"name": "limit", "in": "query", "schema": map[string]any{"type": "integer", "default": 50, "minimum": 1, "maximum": 200}, "description": "Recent requests only. Missing, invalid or nonpositive values use 50; values above 200 are capped."},
		}
		responses["400"] = map[string]any{"description": "Invalid IP", "content": jsonContent(schemaRef("AppError"))}
		responses["404"] = map[string]any{"description": "No records in the caller's team scope", "content": jsonContent(schemaRef("AppError"))}
	}
	responses["200"] = successResponse(name)
	responses["200"].(map[string]any)["headers"] = map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}
	for code, description := range map[string]string{"401": "Invalid authentication or missing admin read scope", "405": "Unsupported method", "500": "Aggregate or team scope query failed"} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func ipUsageOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	count := map[string]any{"type": "integer"}
	number := map[string]any{"type": "number"}
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for key := range properties {
			required = append(required, key)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "required": required, "properties": properties}
	}
	list := func(name string, limit int) map[string]any {
		out := map[string]any{"type": "array", "items": schemaRef(name)}
		if limit > 0 {
			out["maxItems"] = limit
		}
		return out
	}
	return map[string]any{
		"IPUsageSummary":  object(map[string]any{"ip": text, "requests": count, "tokens": count, "cost_krw": number, "average_latency_ms": number, "last_seen": text, "distinct_keys": count}),
		"IPUsageList":     object(map[string]any{"ips": list("IPUsageSummary", 200)}),
		"IPUsageGroup":    object(map[string]any{"key": text, "requests": count, "tokens": count, "cost_krw": number, "average_latency_ms": number}),
		"IPUsageDay":      object(map[string]any{"date": text, "bucket": text, "requests": count, "tokens": count, "cost_krw": number}),
		"IPUsageLanguage": object(map[string]any{"language": text, "requests": count, "average_confidence": number}),
		"IPUsageRecent":   object(map[string]any{"id": text, "model": text, "status_code": count, "latency_ms": count, "total_tokens": count, "estimated_cost": number, "created_at": text}),
		"IPUsageDetail":   object(map[string]any{"stats": schemaRef("IPUsageSummary"), "daily": list("IPUsageDay", 60), "by_model": list("IPUsageGroup", 50), "by_key": list("IPUsageGroup", 50), "by_language": list("IPUsageLanguage", 50), "recent": list("IPUsageRecent", 200)}),
	}
}
