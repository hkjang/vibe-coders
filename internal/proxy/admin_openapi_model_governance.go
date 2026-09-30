package proxy

// These schemas describe existing handlers. They do not add revision checks,
// validate stored legacy thresholds, change authorization or alter audit policy.
func enrichModelGovernanceOpenAPIOperation(key string, op, responses map[string]any) {
	appError := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	responses["401"] = appError("invalid_api_key: GET requires existing admin read access; POST and DELETE require admin write access, including the read-only contract evaluation POST.")
	responses["405"] = appError("method_not_allowed: unsupported HTTP method")
	switch key {
	case "get /admin/models/contracts":
		op["parameters"] = []any{map[string]any{"name": "enabled", "in": "query", "required": false, "schema": map[string]any{"type": "string"}, "description": "Exactly 1 selects enabled contracts only; other values list all contracts."}}
		op["description"] = "Returns confirmed contract rows, ordered by task type and name. No rows is contracts: []; lookup failure is an error, never a missing/null array."
		responses["200"] = successResponse("ModelContractListResponse")
		responses["500"] = appError("list_failed: no confirmed contract snapshot")
	case "post /admin/models/contracts":
		op["requestBody"] = requestBody("ModelContractWriteRequest")
		op["description"] = "Upserts by the Go-trimmed id. An omitted, null or blank id generates a new row; editing must send the original id. All editable fields are replaced; omitted/null thresholds become 0 (not enforced), omitted/null enabled becomes true, and explicit false is preserved. Existing created_by and created_at are retained on update. Unknown IDs are inserted; this is not a conditional update and no revision/CAS is provided. Audit is existing pseudonymous admin token identity and post-write best-effort, not atomic."
		responses["200"] = successResponse("ModelContractSavedResponse")
		responses["400"] = appError("invalid_body or no_name: incompatible JSON or blank trimmed name")
		responses["500"] = appError("upsert_failed: contract storage failed")
	case "delete /admin/models/contracts":
		op["parameters"] = []any{map[string]any{"name": "id", "in": "query", "required": true, "schema": map[string]any{"type": "string", "minLength": 1}, "description": "Go-trimmed exact contract ID. Blank is rejected; a missing row is idempotent success."}}
		op["description"] = "Deletes the exact trimmed ID without a revision/CAS check. The audit entry is post-write best-effort."
		responses["200"] = successResponse("ModelContractDeletedResponse")
		responses["400"] = appError("no_id: id query parameter is blank")
		responses["500"] = appError("delete_failed: contract deletion failed")
	case "post /admin/models/contracts/run":
		op["requestBody"] = requestBody("ModelContractRunRequest")
		op["description"] = "Read-only computation over observed database metrics, not an upstream model call, stored run, policy change or audit event. Still requires existing admin write scope because it is POST. An explicit contract_id selects that contract even if disabled; omission selects enabled contracts. Missing metric queries yield have_metrics=false/no_data rather than proof of safety. No contracts means replaceable=false. Failure samples contain fingerprints and reasons, not raw responses."
		responses["200"] = successResponse("ModelContractRunResponse")
		responses["400"] = appError("invalid_body or no_model: invalid JSON or blank trimmed model")
		responses["404"] = appError("not_found: explicit contract_id does not exist")
		responses["500"] = appError("contract_lookup_failed or list_failed: contracts could not be resolved")
	case "get /admin/model-deprecations":
		op["description"] = "Returns confirmed stored policies ordered by model_glob, including custom/imported IDs. Empty is deprecations: []; query failure is an error."
		responses["200"] = successResponse("ModelDeprecationListResponse")
		responses["500"] = appError("deprecations_failed: no confirmed policy snapshot")
	case "post /admin/model-deprecations":
		op["requestBody"] = requestBody("ModelDeprecationWriteRequest")
		op["description"] = "Upserts using an ID derived from ToLower(TrimSpace(model_glob)); the stored pattern retains its trimmed spelling. The same normalized pattern replaces the canonical policy; a different pattern creates another policy, not a rename. No id request field is used, so custom/imported IDs cannot be targeted by this POST. Omitted/null optional fields become empty, not preserved. Empty sunset_date is warn-only indefinitely; otherwise the date is UTC and after sunset a replacement rewrites requests or an empty replacement blocks them. Both insertion and update return 201. Only this pod's cache is invalidated immediately; other pods may retain their existing cache. No CAS or atomic audit guarantee is provided."
		responses["201"] = successResponse("ModelDeprecationSavedResponse")
		responses["400"] = appError("invalid_body, missing_model_glob or invalid_sunset_date: invalid JSON, blank pattern or invalid calendar date")
		responses["500"] = appError("deprecation_save_failed: policy storage failed")
	case "delete /admin/model-deprecations/{id}":
		op["description"] = "Deletes by the supplied path ID after removing boundary slashes. A missing row is idempotent success; do not normalize an ambiguous ID into a different target. Cache invalidation is local to this pod and audit is post-write best-effort, not an atomic multi-pod operation."
		responses["200"] = successResponse("ModelDeprecationDeletedResponse")
		responses["400"] = appError("missing_id: empty deprecation ID")
		responses["500"] = appError("deprecation_delete_failed: policy deletion failed")
	}
}

func modelGovernanceOpenAPISchemas() map[string]any {
	text := func() map[string]any { return map[string]any{"type": "string"} }
	number := func() map[string]any { return map[string]any{"type": "number", "format": "double"} }
	boolean := func() map[string]any { return map[string]any{"type": "boolean"} }
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "required": required, "properties": properties}
	}
	array := func(name string) map[string]any { return map[string]any{"type": "array", "items": schemaRef(name)} }
	nullable := func(schema map[string]any) map[string]any { schema["nullable"] = true; return schema }
	contractFields := func() map[string]any {
		return map[string]any{
			"id": text(), "name": text(), "task_type": text(),
			"min_quality_score": number(), "min_golden_pass_rate": number(), "min_success_rate": number(),
			"max_latency_ms": map[string]any{"type": "integer", "format": "int64"}, "max_avg_cost_krw": number(), "enabled": boolean(),
		}
	}
	contract := contractFields()
	contract["created_by"] = map[string]any{"type": "string", "description": "Existing pseudonymous admin token actor, not a user ID; retained on update."}
	contract["created_at"], contract["updated_at"] = text(), text()
	write := contractFields()
	for name, value := range write {
		if name != "name" {
			value.(map[string]any)["nullable"] = true
		}
	}
	write["enabled"].(map[string]any)["default"] = true
	write["id"].(map[string]any)["description"] = "Send the immutable original ID for editing; blank/omitted/null generates a new row."
	deprecationFields := func() map[string]any {
		return map[string]any{"model_glob": text(), "replacement": text(), "sunset_date": text(), "message": text()}
	}
	deprecation := deprecationFields()
	deprecation["id"], deprecation["created_at"], deprecation["updated_at"] = text(), text(), text()
	deprecationWrite := deprecationFields()
	for _, name := range []string{"replacement", "sunset_date", "message"} {
		deprecationWrite[name].(map[string]any)["nullable"] = true
	}
	deprecationWrite["sunset_date"].(map[string]any)["description"] = "Empty/omitted/null is warn-only; otherwise an actual YYYY-MM-DD calendar date in UTC."
	return map[string]any{
		"ModelContractRecord":          object([]string{"id", "name", "task_type", "min_quality_score", "min_golden_pass_rate", "min_success_rate", "max_latency_ms", "max_avg_cost_krw", "enabled", "created_by", "created_at", "updated_at"}, contract),
		"ModelContractListResponse":    object([]string{"contracts"}, map[string]any{"contracts": array("ModelContractRecord")}),
		"ModelContractWriteRequest":    object([]string{"name"}, write),
		"ModelContractSavedResponse":   object([]string{"id", "ok"}, map[string]any{"id": text(), "ok": map[string]any{"type": "boolean", "enum": []bool{true}}}),
		"ModelContractDeletedResponse": object([]string{"ok"}, map[string]any{"ok": map[string]any{"type": "boolean", "enum": []bool{true}}}),
		"ModelContractRunRequest":      object([]string{"model"}, map[string]any{"model": text(), "contract_id": nullable(text()), "window": map[string]any{"type": "string", "nullable": true, "description": "Existing parseWindow syntax (for example 1h, 24h, 7d, 30d); omitted, null or unrecognized values fall back to 30 days."}}),
		"ModelContractCheck": object([]string{"dimension", "threshold", "actual", "status"}, map[string]any{
			"dimension": text(), "threshold": number(), "actual": nullable(number()),
			"status": map[string]any{"type": "string", "enum": []string{"pass", "warn", "fail", "no_data", "skip"}},
		}),
		"ModelContractRunResult": object([]string{"contract_id", "contract_name", "task_type", "verdict", "replaceable", "checks"}, map[string]any{
			"contract_id": text(), "contract_name": text(), "task_type": text(), "replaceable": boolean(), "checks": array("ModelContractCheck"),
			"verdict": map[string]any{"type": "string", "enum": []string{"pass", "warn", "fail", "no_data"}},
		}),
		"ModelContractFailureSample": object([]string{"fingerprint", "reason"}, map[string]any{"fingerprint": text(), "reason": text()}),
		"ModelContractRunResponse": object([]string{"model", "window", "replaceable", "note", "have_metrics", "results", "failing_samples"}, map[string]any{
			"model": text(), "window": text(), "replaceable": boolean(), "note": text(),
			"have_metrics": object([]string{"quality", "latency", "cost"}, map[string]any{"quality": boolean(), "latency": boolean(), "cost": boolean()}),
			"results":      array("ModelContractRunResult"), "failing_samples": array("ModelContractFailureSample"),
		}),
		"ModelGovernanceDeprecation":      object([]string{"id", "model_glob", "replacement", "sunset_date", "message", "created_at", "updated_at"}, deprecation),
		"ModelDeprecationListResponse":    object([]string{"deprecations"}, map[string]any{"deprecations": array("ModelGovernanceDeprecation")}),
		"ModelDeprecationWriteRequest":    object([]string{"model_glob"}, deprecationWrite),
		"ModelDeprecationSavedResponse":   object([]string{"deprecation"}, map[string]any{"deprecation": schemaRef("ModelGovernanceDeprecation")}),
		"ModelDeprecationDeletedResponse": object([]string{"id", "deleted"}, map[string]any{"id": text(), "deleted": map[string]any{"type": "boolean", "enum": []bool{true}}}),
	}
}
