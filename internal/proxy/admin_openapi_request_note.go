package proxy

import "strings"

func enrichRequestNoteOpenAPIOperation(method string, op, responses map[string]any) {
	appError := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	parameters, _ := op["parameters"].([]any)
	patch := strings.EqualFold(method, "patch")
	header := map[string]any{
		"name": "X-Vibe-UI", "in": "header", "required": patch,
		"schema":      map[string]any{"type": "string"},
		"description": "Exactly app selects the app response metadata and preserve_fields write extension. Other values retain the legacy contract. This is not an authorization credential.",
	}
	if patch {
		header["schema"] = map[string]any{"type": "string", "enum": []string{"app"}}
	}
	op["parameters"] = append(parameters, header)
	responses["200"] = successResponse("RequestNoteResponse")
	responses["400"] = appError("invalid_request_id or invalid_body: invalid path or payload; no write")
	responses["401"] = appError("invalid_api_key: GET requires admin read scope; POST, PUT, PATCH and DELETE require admin write scope. Raw-view permission is separate.")
	responses["403"] = appError("cross_team_access_denied: request is outside the caller's team scope")
	responses["404"] = appError("request_not_found: the underlying request does not exist, even if an operator note remains")
	responses["405"] = appError("method_not_allowed: GET, POST, PUT and DELETE remain supported; PATCH additionally requires X-Vibe-UI: app. Older servers reject PATCH without writing; never fall back to PUT or POST.")
	switch strings.ToLower(method) {
	case "get":
		op["description"] = "Returns the caller-visible note and tags, with existing raw-view and team-scope rules. X-Vibe-UI: app adds required exists and redacted_fields metadata, calculated from actual projection changes rather than marker text. A missing note is a successful empty response with exists=false; a stored empty note has exists=true. A query failure is an error, not an empty note."
		responses["500"] = appError("request_lookup_failed or note_failed: request/note lookup failed; no confirmed snapshot")
	case "post", "put", "patch":
		op["description"] = "Full replacement unless X-Vibe-UI: app explicitly lists note and/or tags in preserve_fields. Unpreserved omitted or null fields become empty; for PUT/POST an empty object or null body clears both fields. For app requests preserve_fields must be a non-null array of unique allowed field names; a preserved field must not also appear as a replacement value, including null. Preserved columns retain their current database values atomically, not a browser projection; a missing row is created with empty preserved fields. App success returns its own committed row with exists=true, actual updated_at, and redacted_fields, without a post-commit reread. No marker reverse-mapping, revision/CAS or raw-view privilege elevation is provided. For PUT/POST without the app header preserve_fields remains an ignored unknown field and legacy replacement semantics apply. Audit remains post-commit best-effort and contains only request ID and tag count, not note/tag text."
		op["requestBody"] = requestBody("RequestNoteWriteRequest")
		if patch {
			op["description"] = op["description"].(string) + " PATCH requires both X-Vibe-UI: app and an explicit preserve_fields array, including [] for replacement/clear. App editors must use PATCH for every save; older mixed-version mutation recipients reject this unsupported method with 405 before writing. A bootstrap version check alone cannot guarantee the mutation recipient version. Never automatically fall back to PUT or POST."
			op["requestBody"] = requestBody("RequestNotePatchRequest")
			responses["200"] = successResponse("RequestNoteAppResponse")
		}
		responses["500"] = appError("request_lookup_failed or note_save_failed: lookup or storage failed; no success snapshot returned")
	case "delete":
		op["description"] = "Deletes both tags and note for the fixed request ID. A missing note is idempotent success, including tags-only and empty rows, provided the underlying request exists and is in scope. There is no revision/CAS check. The existing audit is best-effort, not atomic with deletion."
		responses["200"] = successResponse("RequestNoteDeletedResponse")
		responses["500"] = appError("request_lookup_failed or note_delete_failed: lookup or deletion failed")
	}
}

func requestNoteOpenAPISchemas() map[string]any {
	fields := func() map[string]any {
		return map[string]any{
			"request_id": map[string]any{"type": "string"},
			"tags":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"note":       map[string]any{"type": "string"},
			"created_by": map[string]any{"type": "string", "description": "Existing last-writer audit identity (token hash label, or anonymous), not a user ID; subject to the caller's projection."},
			"updated_at": map[string]any{"type": "string", "format": "date-time", "description": "Actual stored time for app save responses. Missing notes and legacy save responses can contain the zero timestamp."},
		}
	}
	fieldNames := func() map[string]any {
		return map[string]any{"type": "array", "uniqueItems": true, "maxItems": 2, "items": map[string]any{"type": "string", "enum": []string{"note", "tags"}}}
	}
	app := fields()
	app["exists"] = map[string]any{"type": "boolean", "description": "Whether the note row exists; an existing row may have both note and tags empty."}
	app["redacted_fields"] = fieldNames()
	app["redacted_fields"].(map[string]any)["description"] = "Editable fields actually changed by the caller-visible projection. An unchanged literal marker does not imply redaction; tags are one complete field, never reverse-mapped individually. Always an array, including when empty."
	writeFields := map[string]any{
		"note":            map[string]any{"type": "string", "nullable": true, "description": "Replacement text with surrounding Go whitespace trimmed. Omitted/null means empty unless explicitly preserved; must be absent when preserved."},
		"tags":            map[string]any{"type": "array", "nullable": true, "items": map[string]any{"type": "string"}, "description": "Complete replacement with existing leading-# removal, whitespace trimming, comma replacement and exact deduplication. Omitted/null means empty unless explicitly preserved; must be absent when preserved."},
		"preserve_fields": fieldNames(),
	}
	return map[string]any{
		"RequestNoteLegacyResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"request_id", "tags", "note", "created_by", "updated_at"}, "properties": fields(),
		},
		"RequestNoteAppResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"request_id", "tags", "note", "created_by", "updated_at", "exists", "redacted_fields"}, "properties": app,
		},
		"RequestNoteResponse": map[string]any{
			"description": "X-Vibe-UI: app selects RequestNoteAppResponse; other clients receive RequestNoteLegacyResponse.",
			"oneOf":       []any{schemaRef("RequestNoteAppResponse"), schemaRef("RequestNoteLegacyResponse")},
		},
		"RequestNoteWriteRequest": map[string]any{
			"type": "object", "nullable": true,
			"description": "Existing optional/null replacement semantics apply unless an app request explicitly preserves that field. Unknown fields remain ignored for compatibility; preserve_fields validation applies only with X-Vibe-UI: app.",
			"properties":  writeFields,
		},
		"RequestNotePatchRequest": map[string]any{
			"type": "object", "required": []string{"preserve_fields"}, "properties": writeFields,
			"description": "App-only explicit intent. preserve_fields is required and non-null, including [] when replacing/clearing both fields. Preserved fields must not also occur as values, even null. No PUT/POST fallback is safe on an older server.",
		},
		"RequestNoteDeletedResponse": map[string]any{
			"type": "object", "required": []string{"id", "status"},
			"properties": map[string]any{"id": map[string]any{"type": "string"}, "status": map[string]any{"type": "string", "enum": []string{"deleted"}}},
		},
	}
}
