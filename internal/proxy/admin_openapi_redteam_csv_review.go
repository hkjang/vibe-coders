package proxy

import (
	"sort"
	"vibe-coders/internal/store"
)

func enrichRedTeamProbeCSVReviewOpenAPI(applying bool, op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	op["description"] = "Review or apply a probe CSV with existing admin:write AND admin:read. CSV file bytes (including BOM/line endings) are bound to the verified subject, session, team, role, sorted scopes, prospective values and current affected catalogue contents/update timestamps. Review is a consistent read with no seeding or apply audit. Only CSV-representable content is disclosed; execution parameters and provenance are excluded. A revision is a state precondition, not a secret, expiring reservation or proof a human reviewed every page. Source data rows are limited to 10000; affected existing text to 32 MiB and each JSON review page to 32 MiB. Exceeding a limit rejects, never truncates. First usable row owns each pack; last duplicate case ID wins; receipt counts source rows. Apply obtains a database write lock before checking the precondition, then commits all pack/case changes and one audit together. Concurrent legacy or other-process writers cannot slip between that check and apply. Existing pack version/enabled/creation metadata, case parameters and omitted cases remain. Do not automatically replay after an uncertain response or fall back to legacy POST. Legacy POST import remains separate and does not gain the review row cap."
	op["requestBody"] = map[string]any{"required": true, "content": map[string]any{
		"text/csv":            map[string]any{"schema": map[string]any{"type": "string", "x-body-max-bytes": redTeamProbeCSVMaxBytes, "description": "Original UTF-8 CSV bytes without NUL, at most 8 MiB. Legacy or marked probe-v1 format; marked escapes preserve text/lists. Repeat the exact same extracted file bytes for every page and apply."}},
		"multipart/form-data": map[string]any{"schema": map[string]any{"type": "object", "required": []string{"file"}, "properties": map[string]any{"file": map[string]any{"type": "string", "format": "binary"}}, "x-body-max-bytes": redTeamProbeCSVMaxBytes + redTeamProbeMultipartOverhead, "description": "File part at most 8 MiB; complete multipart request at most 9 MiB. Only extracted file bytes are revision-bound."}},
	}}
	parameters := []any{map[string]any{"name": "If-Match", "in": "header", "required": applying, "description": "Exactly one quoted lowercase SHA-256 revision, required for PUT and any offset greater than zero. No weak, wildcard or multi-value tags. A refreshed JWT in the same effective session preserves identity.", "schema": map[string]any{"type": "string", "pattern": "^\"[a-f0-9]{64}\"$"}}}
	response := "RedTeamProbeCSVReview"
	if applying {
		response = "RedTeamProbeCSVApplied"
	} else {
		parameters = append(parameters,
			map[string]any{"name": "offset", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "minimum": 0, "maximum": 2 * store.RedTeamProbeReviewMaxRows, "default": 0}, "description": "Zero-based unique change offset. Nonzero offsets require If-Match. Only one value; no unknown query parameters."},
			map[string]any{"name": "limit", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 50}})
	}
	op["parameters"] = parameters
	responses["200"] = successResponse(response)
	ok := responses["200"].(map[string]any)
	ok["headers"] = map[string]any{"Cache-Control": map[string]any{"schema": map[string]any{"type": "string", "enum": []string{"no-store"}}}}
	if !applying {
		ok["headers"].(map[string]any)["ETag"] = map[string]any{"schema": map[string]any{"type": "string", "pattern": "^\"[a-f0-9]{64}\"$"}}
	}
	responses["400"] = errorResponse("Malformed CSV, UTF-8/NUL, no eligible rows, content type, strict query or If-Match: invalid_csv, invalid_csv_format, empty_csv, bad_body, invalid_csv_review. PUT accepts no query parameters.")
	responses["401"] = errorResponse("Existing subtree authentication/write scope rejection: invalid_api_key.")
	responses["403"] = errorResponse("Missing additional existing catalogue read scope: redteam_import_read_required.")
	responses["409"] = errorResponse("File, effective account/session or affected state changed: redteam_import_review_changed. Review again.")
	responses["413"] = errorResponse("File/envelope or review row/snapshot/encoded-page limit: csv_too_large, redteam_import_review_limit. Split the file; no partial review is returned.")
	if applying {
		responses["500"] = errorResponse("Mutation/audit failed or commit acknowledgment unknown: redteam_pack_save_failed, redteam_case_save_failed, redteam_import_save_failed. Check current catalogue before an explicit retry.")
	} else {
		responses["503"] = errorResponse("Database read failed or stored text cannot be represented safely: redteam_import_review_unavailable.")
	}
}

func redTeamProbeCSVReviewOpenAPISchemas() map[string]any {
	object := func(properties map[string]any) map[string]any {
		required := make([]string, 0, len(properties))
		for k := range properties {
			required = append(required, k)
		}
		sort.Strings(required)
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	text := map[string]any{"type": "string"}
	boolean := map[string]any{"type": "boolean"}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": 2 * store.RedTeamProbeReviewMaxRows}
	revision := map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	stringsArray := map[string]any{"type": "array", "items": text}
	pack := object(map[string]any{"id": text, "name": text, "category": text, "severity": text, "version": text, "enabled": boolean, "requires_approval": boolean})
	probe := object(map[string]any{"id": text, "pack_id": text, "case_key": text, "input_template": text, "expected_policy": text, "evaluator_type": text, "severity": text, "risk_tags": stringsArray, "target_types": stringsArray})
	change := func(kind, value string) map[string]any {
		return object(map[string]any{
			"kind": map[string]any{"type": "string", "enum": []string{kind}},
			"id":   text, "action": map[string]any{"type": "string", "enum": []string{"create", "update", "unchanged"}},
			"before": map[string]any{"type": "object", "nullable": true, "allOf": []any{schemaRef(value)}, "description": "Null for a new entity; otherwise the full CSV-editable before value plus preserved version/enabled for packs."},
			"after":  schemaRef(value),
		})
	}
	skipped := map[string]any{"type": "array", "nullable": true, "maxItems": store.RedTeamProbeReviewMaxRows, "items": text, "description": "Source row diagnostics; null when none. No prompt content."}
	return map[string]any{
		"RedTeamProbePackValue":  pack,
		"RedTeamProbeCaseValue":  probe,
		"RedTeamProbePackChange": change("pack", "RedTeamProbePackValue"),
		"RedTeamProbeCaseChange": change("case", "RedTeamProbeCaseValue"),
		"RedTeamProbeCSVChange":  map[string]any{"oneOf": []any{schemaRef("RedTeamProbePackChange"), schemaRef("RedTeamProbeCaseChange")}, "discriminator": map[string]any{"propertyName": "kind", "mapping": map[string]any{"pack": "#/components/schemas/RedTeamProbePackChange", "case": "#/components/schemas/RedTeamProbeCaseChange"}}},
		"RedTeamProbeCSVReview": object(map[string]any{
			"review_supported": map[string]any{"type": "boolean", "enum": []bool{true}}, "revision": revision, "file_sha256": revision,
			"imported_cases": count, "packs_touched": count, "skipped": skipped,
			"counts":      object(map[string]any{"created": count, "updated": count, "unchanged": count}),
			"total_items": count, "offset": count, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "has_more": boolean,
			"changes": map[string]any{"type": "array", "maxItems": 100, "items": schemaRef("RedTeamProbeCSVChange")},
		}),
		"RedTeamProbeCSVApplied": object(map[string]any{
			"review_applied": map[string]any{"type": "boolean", "enum": []bool{true}}, "applied_revision": revision, "imported_cases": count, "packs_touched": count, "skipped": skipped,
		}),
	}
}
