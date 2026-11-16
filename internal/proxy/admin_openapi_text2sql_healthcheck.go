package proxy

func enrichText2SQLHealthcheckOpenAPI(op, responses map[string]any) {
	op["description"] = "Explicit admin:read connectivity diagnostic. Uses the currently stored enabled named connection's driver and encrypted DSN, or environment/runtime defaults for empty/default ID; never reuses a stale execution pool. No DDL/DML or account-wide privilege inference. PostgreSQL checks a READ ONLY transaction, a local 1s diagnostic statement timeout, and SELECT 1. Other registered drivers check connectivity and a constant query only (Oracle: SELECT 1 FROM DUAL). The whole diagnostic is bounded by a 10s context. statement_timeout is the configured execution setting, not the diagnostic timeout or proof it is enforced. Nullable checks mean not performed, never success/failure. account_write_restricted is always null: a temporary-table probe cannot establish account-wide privileges. Database/driver error text and DSNs are never returned. Diagnostics use 200 with status; authorization remains 401/403. Responses are no-store."
	op["parameters"] = []any{map[string]any{"name": "connection_id", "in": "query", "schema": map[string]any{"type": "string"}, "description": "Stored connection ID; empty/default selects environment/runtime defaults."}}
	responses["200"] = successResponse("Text2SQLHealthcheck")
	for _, code := range []string{"401", "403"} {
		responses[code] = map[string]any{"description": "Existing admin authorization denied", "content": jsonContent(schemaRef("AppError"))}
	}
}

func text2SQLHealthcheckOpenAPISchemas() map[string]any {
	fields := map[string]any{}
	required := []string{"status", "detail", "detail_code", "configured", "driver", "statement_timeout", "connection_id", "reachable", "query_ok", "read_only_tx_ok", "statement_timeout_ok", "account_write_restricted", "probe_timeout"}
	for _, field := range []string{"detail", "detail_code", "driver", "statement_timeout", "connection_id", "probe_timeout"} {
		fields[field] = map[string]any{"type": "string"}
	}
	fields["status"] = map[string]any{"type": "string", "enum": []string{"ok", "warn", "error", "preview_only"}}
	fields["configured"] = map[string]any{"type": "boolean"}
	for _, field := range []string{"reachable", "query_ok", "read_only_tx_ok", "statement_timeout_ok", "account_write_restricted"} {
		fields[field] = map[string]any{"type": "boolean", "nullable": true, "description": "Null means not checked. Account-wide write restrictions are not inferred by this diagnostic."}
	}
	return map[string]any{"Text2SQLHealthcheck": map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": fields}}
}
