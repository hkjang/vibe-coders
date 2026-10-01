package proxy

func enrichRoutingLearningOpenAPI(op, responses map[string]any) {
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	op["description"] = "Read historical learning aggregates with existing routing:read authorization; creating a separate routing rule requires routing:write. Rows are grouped by task_type, complexity bucket and recorded model for endpoints matching %chat/completions% since the query lower bound. Current score buckets are low 0-33, medium 34-66, high 67-100 within the usual 0-100 score domain; the SQL classifies any recorded value below 34 as low and any value at least 67 as high. These labels are extensible strings. window accepts named periods or any positive Go duration, with default 7d for omitted/invalid/nonpositive input. min_samples accepts a positive Go integer, with default 20 otherwise. The floor filters eligible recommendations, not observed cells. differs compares the recommendation to the most-used observed model and is not a saved-rule existence/effectiveness check. confident means every observed model in that task/bucket meets the sample floor, not an operational safety approval. since is a seconds-precision UTC rendering of the lower bound, not a snapshot or revision token; the actual SQL filter uses its original higher-precision value. This unpaginated aggregate has no team filter or upper-bound query parameter, and it neither creates rules nor enables automatic learning. Model/task/rationale text is unmasked metadata, not a PII-free projection. A separately created model/complexity rule does not gain a task_type condition merely from its note."
	op["parameters"] = []any{
		map[string]any{"name": "window", "in": "query", "required": false,
			"description": "24h, 7d, 30d and 90d are recognized; other positive time.ParseDuration values such as 2h are accepted. Omitted, invalid or nonpositive values select seven days. No closed enum or new range restriction.",
			"schema":      map[string]any{"type": "string", "default": "7d"}},
		map[string]any{"name": "min_samples", "in": "query", "required": false,
			"description": "Query text parsed with strconv.Atoi; a positive platform-sized integer is used, otherwise 20. This is a recommendation eligibility threshold, not a limit on returned cells or rows. No new upper cap is imposed.",
			"schema":      map[string]any{"type": "string", "default": "20"}},
	}
	responses["200"] = successResponse("RoutingLearningReport")
	responses["401"] = errorResponse("invalid_api_key: existing authentication or routing:read scope rejection. Legacy read-only credentials permit this GET, but not a later routing-rule POST.")
	responses["405"] = errorResponse("method_not_allowed: the existing handler requires GET after authorization.")
	responses["500"] = errorResponse("routing_learning_failed: the historical aggregate could not be read. No fallback estimate or automatic rule creation is implied.")
}

func routingLearningOpenAPISchemas() map[string]any {
	text := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	integer := func(description string) map[string]any {
		return map[string]any{"type": "integer", "format": "int64", "description": description}
	}
	number := func(description string) map[string]any {
		return map[string]any{"type": "number", "format": "double", "description": description}
	}
	bucket := func() map[string]any {
		return text("Current SQL buckets: low (<34), medium (34 through 66), high (>=67); usual valid score ranges 0-33/34-66/67-100. No enum: future labels remain representable.")
	}
	return map[string]any{
		"RoutingLearningReport": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"since", "min_samples", "cells", "recommendations"},
			"properties": map[string]any{
				"since":           map[string]any{"type": "string", "format": "date-time", "description": "UTC RFC3339 seconds-only lower-bound display. Original filter precision is higher; not an exact replay watermark, upper bound, snapshot or revision."},
				"min_samples":     map[string]any{"type": "integer", "format": "int64", "minimum": 1, "description": "Effective positive sample floor after query normalization."},
				"cells":           map[string]any{"type": "array", "items": schemaRef("RoutingLearningCell"), "description": "Every observed task/bucket/model aggregate, including below-floor models. Empty is [], not null."},
				"recommendations": map[string]any{"type": "array", "items": schemaRef("RoutingLearningRecommendation"), "description": "One recommendation per task/bucket having an eligible model. Empty is [], not null. Not a list of stored rules."},
			},
		},
		"RoutingLearningCell": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"task_type", "bucket", "model", "requests", "successes", "success_rate", "fallback_rate", "avg_cost_krw", "avg_latency_ms", "thumbs_up", "thumbs_down"},
			"properties": map[string]any{
				"task_type": text("Recorded task type; empty or null storage values group as other."),
				"bucket":    bucket(), "model": text("Recorded model spelling is preserved; empty or null groups as (unknown). No frontend whitespace normalization is implied."),
				"requests":       integer("COUNT of joined aggregate rows; not a deduplicated global traffic total."),
				"successes":      integer("Rows with 2xx status, no recorded error and no failover."),
				"success_rate":   number("successes divided by requests."),
				"fallback_rate":  number("SUM of recorded failover values divided by requests."),
				"avg_cost_krw":   number("Average joined estimated_cost, treating missing values as zero. Historical estimate, not a future bill or currency conversion proof."),
				"avg_latency_ms": number("Average recorded latency in milliseconds."),
				"thumbs_up":      integer("Count of joined requests whose net feedback sum is positive; not individual positive feedback events."),
				"thumbs_down":    integer("Count of joined requests whose net feedback sum is negative; not individual negative feedback events."),
			},
		},
		"RoutingLearningRecommendation": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"task_type", "bucket", "recommended_model", "success_rate", "avg_cost_krw", "samples", "top_model", "top_success_rate", "differs", "confident", "rationale"},
			"properties": map[string]any{
				"task_type": text("Evidence task type, not a condition in the separate routing-rule API."),
				"bucket":    bucket(), "recommended_model": text("Eligible observed model chosen by success-rate comparison with existing 0.005 tolerance, then lower cost, then more samples. Raw spelling retained."),
				"success_rate":     number("Chosen model's observed success rate."),
				"avg_cost_krw":     number("Chosen model's historical average estimated cost."),
				"samples":          integer("Chosen model's observed request count, not all models' combined samples."),
				"top_model":        text("Most-used observed model in this task/bucket, not the currently configured routing target."),
				"top_success_rate": number("Most-used observed model's success rate."),
				"differs":          map[string]any{"type": "boolean", "description": "recommended_model != top_model; does not inspect stored routing rules."},
				"confident":        map[string]any{"type": "boolean", "description": "Every observed model in the group meets min_samples; not a probability or approval of live traffic safety."},
				"rationale":        text("Generated explanatory text containing raw model names; not a masked projection."),
			},
		},
	}
}
