package proxy

func enrichDWDashboardOpenAPI(path string, op, responses map[string]any) {
	parameter := func(name string, schema map[string]any) map[string]any {
		return map[string]any{"name": name, "in": "query", "schema": schema}
	}
	text := map[string]any{"type": "string"}
	parameters := []any{parameter("window", text)}
	if path == "/admin/dw/dashboard/timeseries" {
		parameters = append(parameters, parameter("bucket", map[string]any{"type": "string", "enum": []string{"day", "week"}}))
		for _, name := range []string{"model", "provider", "project", "cost_center"} {
			parameters = append(parameters, parameter(name, text))
		}
		responses["200"] = successResponse("DwDashboardTimeseries")
	} else {
		parameters = append(parameters,
			parameter("dimension", map[string]any{"type": "string", "enum": []string{"model", "provider", "project", "cost_center", "all"}}),
			parameter("order_by", map[string]any{"type": "string", "enum": []string{"cost", "requests", "tokens", "errors"}}),
			parameter("limit", map[string]any{"type": "integer", "minimum": 1}),
		)
		for _, name := range []string{"since_day", "until_day"} {
			parameters = append(parameters, parameter(name, map[string]any{"type": "string", "format": "date"}))
		}
		op["description"] = "Existing daily rollup aggregation. Optional since_day (inclusive) and until_day (exclusive) must both occur exactly once and define 1–90 UTC calendar days within the ClickHouse Date range. Invalid, partial or repeated dates return invalid_dw_date_range before any query. When absent, existing window semantics are preserved. Explicit absolute dates take precedence over window. Dimension reads echo since and exclusive until; CSV uses identical date predicates."
		if path == "/admin/dw/dashboard/dimensions" {
			parameters[1].(map[string]any)["required"] = true
			parameters[1].(map[string]any)["schema"] = map[string]any{"type": "string", "enum": []string{"model", "provider", "project", "cost_center"}}
			responses["200"] = successResponse("DwDashboardDimensions")
		} else {
			responses["200"] = map[string]any{"description": "UTF-8 CSV with BOM, same aggregation and bounds as the dimension read.", "content": map[string]any{"text/csv": map[string]any{"schema": map[string]any{"type": "string"}}}}
		}
	}
	op["parameters"] = parameters
	for code, description := range map[string]string{"400": "Invalid dimension or UTC date range; CSV also rejects an unconfigured DW.", "401": "Existing admin authentication/scope rejection.", "502": "ClickHouse query failed."} {
		responses[code] = map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
}

func dwDashboardOpenAPISchemas() map[string]any {
	text := map[string]any{"type": "string"}
	number := map[string]any{"type": "number"}
	flag := map[string]any{"type": "boolean"}
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	point := object([]string{"day", "requests", "tokens", "cost_krw", "errors"}, map[string]any{"day": text, "requests": number, "tokens": number, "cost_krw": number, "errors": number})
	row := object([]string{"value", "requests", "tokens", "cost_krw", "errors", "error_rate"}, map[string]any{"value": text, "requests": number, "tokens": number, "cost_krw": number, "errors": number, "error_rate": number})
	// Only configured is required: unconfigured DW responses intentionally contain
	// no data, and older servers do not advertise date selection support.
	return map[string]any{
		"DwDashboardTimeseries": object([]string{"configured"}, map[string]any{"configured": flag, "since": text, "bucket": text, "date_bounds_supported": flag, "points": map[string]any{"type": "array", "items": point}}),
		"DwDashboardDimensions": object([]string{"configured"}, map[string]any{"configured": flag, "since": text, "until": text, "dimension": text, "order_by": text, "rows": map[string]any{"type": "array", "items": row}}),
	}
}
