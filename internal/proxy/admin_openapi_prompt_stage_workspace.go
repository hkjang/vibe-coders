package proxy

import "slices"

func enrichPromptStageWorkspaceOpenAPI(op, responses map[string]any, method string) {
	op["description"] = "Existing prompt lifecycle API. view=workspace opts into bounded metadata (GET) or a reviewed manual stage change (POST). Global admin:read/write authorization is unchanged. No model deployment or routing changes. Workspace reads combine registered stages and observed versions in one read snapshot. Statistics count requests once and evaluation failure records separately. Stage changes require a keyed revision and a safe non-empty reason, reject concurrent changes with 409, and commit an audit with the stage. No automatic mutation retries. Unsafe identities are hidden and cannot be changed through this view. Legacy requests without view retain their original bodies and success responses."
	op["description"] = op["description"].(string) + " view=promotion-review provides a GET-only full candidate review over a fixed interval (at most 1000 observed versions), with a five-minute actor-bound keyed revision. POST rechecks observations, criteria and stages in the write transaction, then atomically applies all eligible one-step changes and their audit. Any unsafe eligible identity blocks the whole review. No partial application, retry or model deployment."
	params := []any{map[string]any{"name": "view", "in": "query", "schema": map[string]any{"type": "string", "enum": []string{"workspace", "promotion-review"}}}}
	if method == "get" {
		for name, schema := range map[string]any{
			"window": map[string]any{"type": "string", "enum": []string{"1h", "24h", "7d", "30d"}, "default": "7d"},
			"stage":  map[string]any{"type": "string", "enum": []string{"all", "experiment", "validation", "production"}, "default": "all"},
			"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
			"offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0},
		} {
			params = append(params, map[string]any{"name": name, "in": "query", "schema": schema})
		}
		slices.SortFunc(params, func(a, b any) int {
			av, bv := a.(map[string]any)["name"].(string), b.(map[string]any)["name"].(string)
			if av < bv {
				return -1
			}
			if av > bv {
				return 1
			}
			return 0
		})
		responses["200"] = map[string]any{"description": "Legacy view, workspace page or complete bulk review", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("PromptStageLegacyView"), schemaRef("PromptStageWorkspacePage"), schemaRef("PromptStageBulkReview")}})}
	} else {
		op["requestBody"] = map[string]any{"required": true, "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("PromptStageChange"), schemaRef("PromptStageLegacyChange"), schemaRef("PromptStageBulkApply")}})}
		responses["200"] = map[string]any{"description": "Legacy result or committed manual/bulk workspace receipt", "content": jsonContent(map[string]any{"oneOf": []any{schemaRef("PromptStageLegacyResult"), schemaRef("PromptStageChangeReceipt"), schemaRef("PromptStageBulkReceipt")}})}
	}
	op["parameters"] = params
	for _, code := range []string{"400", "401", "403", "405", "409", "500"} {
		responses[code] = map[string]any{"description": "Invalid input, permission, conflicting revision or storage failure", "content": jsonContent(schemaRef("AppError"))}
	}
}
func promptStageWorkspaceOpenAPISchemas() map[string]any {
	obj := func(fields map[string]any) map[string]any {
		required := make([]string, 0, len(fields))
		for name := range fields {
			required = append(required, name)
		}
		slices.Sort(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}
	}
	str := map[string]any{"type": "string"}
	boolean := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": 9007199254740991}
	stamp := map[string]any{"type": "string", "format": "date-time"}
	enum := func(values ...string) map[string]any { return map[string]any{"type": "string", "enum": values} }
	stage := enum("experiment", "validation", "production")
	item := obj(map[string]any{"reference": str, "name": str, "version": str, "stage": enum("experiment", "validation", "production", "unknown"), "registered": boolean, "can_change": boolean, "revision": str, "calls": count, "errors": count, "evaluation_failures": count, "eligible_stage": enum("", "validation", "production"), "updated_at": map[string]any{"type": "string", "format": "date-time", "nullable": true}})
	criterion := obj(map[string]any{"stage": enum("validation", "production"), "minimum_calls": count, "maximum_error_rate": map[string]any{"type": "number", "minimum": 0, "maximum": 1}, "maximum_evaluation_failures_per_call": map[string]any{"type": "number", "minimum": 0}})
	schemas := map[string]any{
		"PromptStageWorkspaceItem": item,
		"PromptStageWorkspacePage": obj(map[string]any{"items": map[string]any{"type": "array", "items": schemaRef("PromptStageWorkspaceItem"), "maxItems": 100}, "total": count, "limit": count, "offset": count, "stage": enum("all", "experiment", "validation", "production"), "window": enum("1h", "24h", "7d", "30d"), "since": stamp, "until": stamp, "criteria": map[string]any{"type": "array", "items": criterion, "minItems": 2, "maxItems": 2}}),
		"PromptStageChange":        obj(map[string]any{"name": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}, "version": map[string]any{"type": "string", "minLength": 1, "maxLength": 256}, "revision": map[string]any{"type": "string", "minLength": 43, "maxLength": 43}, "stage": stage, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 500}}),
		"PromptStageChangeReceipt": obj(map[string]any{"reference": str, "stage": stage, "updated_at": stamp, "revision": str}),
		"PromptStageLegacyView":    map[string]any{"type": "object", "required": []string{"versions", "promotions", "since", "stages"}, "properties": map[string]any{"versions": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": true}}, "promotions": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": true}}, "since": str, "stages": map[string]any{"type": "array", "items": stage}}},
		"PromptStageLegacyResult": map[string]any{"oneOf": []any{
			map[string]any{"type": "object", "required": []string{"promotion"}, "properties": map[string]any{"promotion": map[string]any{"type": "object", "additionalProperties": true}}},
			map[string]any{"type": "object", "required": []string{"promoted", "count"}, "properties": map[string]any{"promoted": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": true}}, "count": count}},
		}},
		"PromptStageLegacyChange": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{"action": str, "prompt_name": str, "prompt_version": str, "stage": stage, "note": str}},
	}
	window := enum("1h", "24h", "7d", "30d")
	revision := map[string]any{"type": "string", "minLength": 43, "maxLength": 43}
	schemas["PromptStageBulkReview"] = obj(map[string]any{
		"window": window, "since": stamp, "until": stamp, "expires_at": stamp, "revision": str,
		"items":          map[string]any{"type": "array", "items": schemaRef("PromptStageWorkspaceItem"), "maxItems": 1000},
		"observed_count": count, "ignored_count": count, "blocked_count": count,
		"criteria": map[string]any{"type": "array", "items": criterion, "minItems": 2, "maxItems": 2},
	})
	schemas["PromptStageBulkApply"] = obj(map[string]any{
		"window": window, "since": stamp, "until": stamp, "revision": revision,
		"reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 500},
	})
	schemas["PromptStageBulkReceipt"] = obj(map[string]any{"count": map[string]any{"type": "integer", "minimum": 1, "maximum": 1000}, "updated_at": stamp, "review_revision": revision})
	return schemas
}
