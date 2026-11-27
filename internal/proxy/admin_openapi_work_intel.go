package proxy

import "strings"

// OpenAPI contract for the work intelligence admin API (work_intel_api.go), following
// docs/WORK_INTELLIGENCE_DESIGN.md section 7.
//
// Every 200 JSON response is the same open object, WorkIntelObject, on purpose: the
// response shapes are still settling, and an open object lets them change without
// regenerating the console's contract. Parameters, request bodies and error codes are
// specific, because the console builds its requests from them.

func workIntelQueryParameter(name, description string, schema map[string]any) map[string]any {
	return map[string]any{"name": name, "in": "query", "description": description, "schema": schema}
}

// workIntelAnalyticsParameters are the query parameters every analysis read accepts.
// status is described by the caller because /automation filters by review status
// where the other reads filter by classification status.
func workIntelAnalyticsParameters(status string) []any {
	query := workIntelQueryParameter
	text := func() map[string]any { return map[string]any{"type": "string"} }
	day := func() map[string]any { return map[string]any{"type": "string", "format": "date"} }
	return []any{
		query("from", "First day of the period, a Seoul calendar date (YYYY-MM-DD). The default period is the last 30 days.", day()),
		query("to", "Last day of the period, a Seoul calendar date (YYYY-MM-DD).", day()),
		query("compare", "Whether to compute the previous period of the same length for comparison.", map[string]any{"type": "string", "enum": []string{"prev", "none"}, "default": "prev"}),
		query("team", "Team to restrict to. A team-scoped administrator is always restricted to their own team.", text()),
		query("user", "User to restrict to.", text()),
		query("category", "Work category ID at any level.", text()),
		query("action", "Action type ID, such as read, analyze, create, modify or verify.", text()),
		query("model", "Model name.", text()),
		query("provider", "Provider name.", text()),
		query("client", "Client name, such as Claude Code or Cursor.", text()),
		query("tool", "MCP tool name.", text()),
		query("status", status, text()),
		query("metric", "The measure that rankings, shares and chart values are computed in.", map[string]any{"type": "string", "enum": []string{"sessions", "requests", "users", "tokens", "cost", "mcp_calls"}, "default": "sessions"}),
		query("limit", "Page size for list reads.", map[string]any{"type": "integer", "minimum": 1}),
		query("offset", "Rows to skip for list reads. List counts stop at 100,000, and a larger offset returns 400 work_intel_offset_too_large.", map[string]any{"type": "integer", "minimum": 0, "maximum": 100000}),
	}
}

func enrichWorkIntelOpenAPI(key string, op map[string]any, responses map[string]any) bool {
	method, route, _ := strings.Cut(key, " ")
	if !strings.HasPrefix(route, workIntelAdminPath+"/") {
		return false
	}
	errorResponse := func(description string) map[string]any {
		return map[string]any{"description": description, "content": jsonContent(schemaRef("AppError"))}
	}
	query := workIntelQueryParameter
	text := func() map[string]any { return map[string]any{"type": "string"} }
	day := func() map[string]any { return map[string]any{"type": "string", "format": "date"} }
	top := func(count int) map[string]any {
		return query("top", "How many of the largest entries to include.", map[string]any{"type": "integer", "minimum": 1, "default": count})
	}
	confidence := func(name, description string) map[string]any {
		return query(name, description, map[string]any{"type": "number", "minimum": 0, "maximum": 1})
	}
	const (
		classificationStatus = "Classification status: classified, review, unclassified or failed."
		classificationMethod = "How the request was classified: rule, llm, cache or manual."
		scopeNote            = " A team-scoped administrator sees only their own team. A caller who may not view raw prompts is not shown any number about fewer distinct users than min_group_size (and more than none): such a group comes back with every measure and every share, delta or rate derived from it null and suppressed: true. Where it is shown next to a total the caller can see, other numbers of that line are withheld as well (fewest users first) until the withheld part includes a group of at least min_group_size users, so that subtracting what is shown from the total does not describe a small group. When the whole scope is that small, the rows of categories or models it used are not listed. scope.small_groups_withheld says these rules apply to the caller."
	)
	analytics := func(extra ...any) []any {
		return append(workIntelAnalyticsParameters(classificationStatus), extra...)
	}

	var parameters []any
	body := ""
	responses["200"] = successResponse("WorkIntelObject")
	switch method + " " + strings.TrimPrefix(route, workIntelAdminPath) {
	case "get /overview":
		op["description"] = "Headline work usage for the period next to the previous period: sessions, requests, users, tokens, cost and MCP calls, the number of teams and active categories, the classified rate, and the distributions by confidence bucket, classification method and status. The three distributions are empty for a caller who may not view raw prompts." + scopeNote
		parameters = analytics()
	case "get /categories":
		op["description"] = "Work categories one level at a time: the top level, or the children of parent. Each row carries current and previous metrics, its share and change, and whether it has children; unclassified and failed requests are totalled separately." + scopeNote
		parameters = analytics(query("parent", "Category ID whose children to list; omit for the top level.", text()))
	case "get /trend":
		op["description"] = "One series per work category over the period in day or week buckets, measured in metric. The largest categories get their own series and the rest are summed into other. A withheld point is null; for a caller who may not view raw prompts, a category with too few users over the period has no series of its own and is part of other, and suppressed: true means the whole scope is too small, with no series at all." + scopeNote
		parameters = analytics(query("bucket", "Width of one point on the time axis.", map[string]any{"type": "string", "enum": []string{"day", "week"}}), top(8))
	case "get /matrix":
		op["description"] = "Teams by work category for the largest categories, measured in metric: the organization heatmap." + scopeNote
		parameters = analytics(top(12))
	case "get /flow":
		op["description"] = "Nodes and links from team to work category to model for the largest entries of each kind, measured in metric. For a caller who may not view raw prompts, a team, category or model with too few users joins the remainder node of its column, a link of too few users is left out, and suppressed_links counts the links left out; node values are the sums of the links shown, and suppressed: true means every link was left out." + scopeNote
		parameters = analytics(top(6))
	case "get /teams":
		op["description"] = "Per-team usage next to the previous period, sessions per user, category diversity, the team's largest and rising categories, and where its mix deviates from the whole organization. Per-user figures divide by active users, not headcount." + scopeNote
		parameters = analytics()
	case "get /models":
		op["description"] = "Which models serve which work: per category and model the share, tokens and cost per session, latency percentiles estimated from histograms, error, retry and model-switch rates and feedback counts, with suggestions for another model where the sample supports one. suppressed: true means every row is withheld from the caller and none is listed." + scopeNote
		parameters = analytics()
	case "get /trends":
		op["description"] = "Signals computed from the aggregates: categories rising over 7 or 30 days, new or declining ones, cost spikes, dependence on one model, concentration in one team and spread across teams. Each signal carries its current and previous values and sample size, and the response states the thresholds that were applied. A caller who may not view raw prompts is not shown a signal about too few users." + scopeNote
		parameters = analytics()
	case "get /automation":
		op["description"] = "Repeated work that could be automated: how often it repeats, in which teams, at what cost, the recommended form (prompt template, skill, MCP tool, workflow, agent or batch), feasibility and risk. Here status filters by review status. Nothing is registered or executed automatically. A view restricted to some teams describes a candidate (teams, volumes, tools, action, timing) by those teams' requests only; a caller who may not view raw prompts is not shown a candidate of too few users." + scopeNote
		parameters = workIntelAnalyticsParameters("Review status: new, reviewing, accepted or dismissed.")
	case "post /automation/{id}/review":
		op["description"] = "Record the review status and a note for one automation candidate and return the updated row. This records the decision only; no automation is created or run. A team-scoped administrator may only review a candidate that no team outside their scope repeats (403 work_intel_team_forbidden)."
		body = "WorkIntelAutomationReview"
	case "get /insights":
		op["description"] = "Insights generated from the aggregates, each with the evidence it rests on (period, comparison, sample and metrics) and a link into the matching analysis. A caller who may not view raw prompts gets insights computed for them on request, without those about too few users." + scopeNote
		parameters = analytics()
	case "post /insights/run":
		op["description"] = "Recompute trends, automation candidates and insights now instead of waiting for the next interval, and report how many insights were generated."
	case "get /sessions":
		op["description"] = "Work sessions, one page at a time: primary and secondary categories, time span, requests, MCP calls, tokens, cost, errors, retries, models used and the completion state. A successful API response is not counted as completion." + scopeNote
		parameters = analytics(
			query("sort", "Field to order the sessions by.", text()),
			query("session_status", "Session state to restrict to.", text()),
		)
	case "get /sessions/{id}":
		op["description"] = "One work session with its segments by category and up to 200 of its requests. A team-scoped administrator can read only their own team's sessions."
	case "get /requests":
		op["description"] = "Classified requests, one page at a time, with category, action type, confidence, method, status, the redacted work title, tags and technologies. The work title, tags and technologies summarise the prompt and are empty for a caller who may not view raw prompts, as is the user label when the deployment has no secret of its own to make pseudonyms with." + scopeNote
		parameters = analytics(
			confidence("min_conf", "Lowest confidence to include."),
			confidence("max_conf", "Highest confidence to include."),
			query("method", classificationMethod, text()),
		)
	case "get /productivity":
		op["description"] = "Estimated minutes and cost saved per category, from the policy's baselines and the sessions confirmed as complete. Without a baseline or completion evidence the estimates are null and reason says why. suppressed: true means the scope is too small, or every row withheld, and no row is listed." + scopeNote
		parameters = analytics()
	case "get /export.csv":
		op["description"] = "The chosen view as CSV with the current filter: UTF-8 with a byte order mark, cells guarded against formula injection, team scope and small-group suppression applied as in the JSON reads. The export is recorded in the audit log."
		parameters = analytics(map[string]any{"name": "view", "in": "query", "required": true, "description": "Which table to export.", "schema": map[string]any{"type": "string", "enum": []string{"categories", "teams", "models", "sessions", "requests"}}})
		responses["200"] = map[string]any{"description": "UTF-8 CSV with a byte order mark.", "content": map[string]any{"text/csv": map[string]any{"schema": map[string]any{"type": "string"}}}}
	case "get /status":
		op["description"] = "State of the classification worker: which features are enabled, the published policy version, cursor, lag and backlog, the last run and error, and the counts by method, failures, LLM calls and cache hits of the last 24 hours."
	case "get /policy":
		op["description"] = "The classification policy draft with its revision, the published version, whether the draft differs from it (dirty), and the default action types and thresholds."
	case "put /policy":
		op["description"] = "Save the draft. expected_revision is the revision the edit started from; another administrator's save in between returns 409 and nothing is written. Classification does not change until the draft is published."
		body = "WorkIntelPolicyWrite"
		responses["409"] = errorResponse("work_policy_conflict: the draft changed since it was loaded.")
		responses["422"] = map[string]any{"description": "work_policy_invalid: the policy has errors; issues lists them by path.", "content": jsonContent(schemaRef("WorkIntelPolicyRejection"))}
	case "get /policy/versions":
		op["description"] = "Published policy versions with who published each and when, the number of categories, and what changed from the version before: categories added, removed, renamed or merged, and rules changed."
	case "get /policy/versions/{version}":
		op["description"] = "The complete policy document of one published version, with its note, publisher and time."
	case "post /policy/publish":
		op["description"] = "Publish the draft as a new policy version, which the classifier uses from then on. Returns the version and its impact: categories removed and requests affected."
		body = "WorkIntelPublish"
	case "post /policy/rollback":
		op["description"] = "Publish the content of an earlier version as a new version and copy it into the draft."
		body = "WorkIntelRollback"
	case "post /policy/test":
		op["description"] = "Classify sample text with the draft or the published policy, optionally with the LLM step, and return the result, the scored candidate categories with their evidence, and whether the LLM was used. The LLM call counts against the worker's per-minute budget; when it is spent the rule result is returned with llm.code llm_budget_exhausted."
		body = "WorkIntelPolicyTest"
	case "post /policy/evaluate":
		op["description"] = "Measure the draft or the published policy against administrator corrections, used as the expected answers: overall and top-level accuracy, totals per category and the most frequent confusions."
		body = "WorkIntelEvaluate"
	case "get /review":
		op["description"] = "Requests that need a decision (low confidence, unclassified or failed) as the same rows as /requests, with a summary of the queue and hints for categories the policy does not have yet. A team-scoped administrator sees only their own team. The hints, like the work titles, are model-written from prompts and empty for a caller who may not view raw prompts."
		parameters = []any{
			query("status", "Classification status to restrict to: review, unclassified or failed.", text()),
			query("category", "Work category ID at any level.", text()),
			confidence("max_conf", "Highest confidence to include."),
			query("limit", "Page size.", map[string]any{"type": "integer", "minimum": 1}),
			query("offset", "Rows to skip; at most 100,000.", map[string]any{"type": "integer", "minimum": 0, "maximum": 100000}),
		}
	case "post /review/correct":
		op["description"] = "Set the category, and optionally the action type, of up to 500 requests. The correction is kept as evaluation data and the aggregates of the affected days are rebuilt."
		body = "WorkIntelCorrect"
	case "get /reclassify":
		op["description"] = "Preview of reclassifying the selected requests with the published policy: how many by status and method, how many manual corrections are kept, the estimated LLM calls, and the revision a run must present before it expires. Also reports the active job, if there is one."
		parameters = []any{
			query("from", "First day to reclassify, a Seoul calendar date (YYYY-MM-DD).", day()),
			query("to", "Last day to reclassify, a Seoul calendar date (YYYY-MM-DD).", day()),
			query("status", classificationStatus, text()),
			query("category", "Work category ID at any level.", text()),
			query("method", classificationMethod, text()),
		}
	case "post /reclassify":
		op["description"] = "Start the reclassification that was previewed and return the job. revision and reviewed_at come from the preview; an expired preview, a policy published since, a revision of another administrator or selection, or a job already running returns 409. Requests the worker classified after the preview are left out of the job; progress.previewed is what the preview counted next to progress.total."
		parameters = []any{map[string]any{"name": "reviewed", "in": "query", "required": true, "description": "Confirms that the preview was reviewed.", "schema": map[string]any{"type": "string", "enum": []string{"1"}}}}
		body = "WorkIntelReclassifyRun"
		responses["409"] = errorResponse("work_reclassify_expired, work_reclassify_conflict or work_job_active: preview again before starting.")
	case "get /reclassify/jobs/{id}":
		op["description"] = "Status and progress of one reclassification job: total, done, changed, failed, and the days rebuilt so far."
	case "post /rebuild":
		op["description"] = "Rebuild the aggregates of a period from the classification facts. For repairing a mismatch between the two; classifications are not changed."
		body = "WorkIntelRebuild"
	default:
		return false
	}

	required := "admin:read"
	if method != "get" {
		required = "admin:write"
	}
	if len(parameters) > 0 {
		op["parameters"] = parameters
	}
	switch {
	case body != "":
		op["requestBody"] = requestBody(body)
		responses["400"] = errorResponse("The body is not valid JSON, or a field or parameter is missing or out of range.")
	case len(parameters) > 0 || strings.Contains(route, "{"):
		responses["400"] = errorResponse("A parameter is malformed or out of range.")
	}
	responses["401"] = errorResponse("invalid_api_key: the token is missing or invalid, or lacks " + required + ".")
	responses["403"] = errorResponse("The caller may not perform this operation, or a team-scoped administrator asked for data outside their own team.")
	return true
}

func workIntelOpenAPISchemas() map[string]any {
	object := func(required []string, properties map[string]any) map[string]any {
		return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
	}
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	day := map[string]any{"type": "string", "format": "date"}
	expectedRevision := map[string]any{"type": "integer", "minimum": 0}
	list := func(item map[string]any) map[string]any { return map[string]any{"type": "array", "items": item} }
	return map[string]any{
		"WorkIntelObject": map[string]any{"type": "object", "additionalProperties": true, "description": "A work intelligence response. Deliberately open: the members are described per operation and may gain fields without a contract change."},
		"WorkIntelPolicyRejection": object([]string{"error", "issues"}, map[string]any{
			"error":  map[string]any{"type": "object", "additionalProperties": true},
			"issues": list(object([]string{"path", "message"}, map[string]any{"path": text, "message": text})),
		}),
		"WorkIntelPolicyWrite": object([]string{"config", "expected_revision", "reason"}, map[string]any{
			"config": schemaRef("WorkIntelObject"), "expected_revision": expectedRevision, "reason": text,
		}),
		"WorkIntelPublish": object([]string{"expected_revision", "note"}, map[string]any{"expected_revision": expectedRevision, "note": text}),
		"WorkIntelRollback": object([]string{"version", "note"}, map[string]any{
			"version": map[string]any{"type": "integer", "minimum": 1}, "note": text,
		}),
		"WorkIntelPolicyTest": object([]string{"text", "use_draft", "use_llm"}, map[string]any{
			"text": map[string]any{"type": "string", "minLength": 1}, "task_type": text, "languages": list(text), "mcp_tools": list(text),
			"client": text, "model": text, "use_draft": flag, "use_llm": flag,
		}),
		"WorkIntelEvaluate": object([]string{"use_draft", "limit"}, map[string]any{
			"use_draft": flag, "limit": map[string]any{"type": "integer", "minimum": 1},
		}),
		"WorkIntelCorrect": object([]string{"request_ids", "category_id", "reason"}, map[string]any{
			"request_ids": map[string]any{"type": "array", "items": text, "minItems": 1, "maxItems": 500},
			"category_id": text, "action_type": text, "reason": text,
		}),
		"WorkIntelReclassifyRun": object([]string{"revision", "reviewed_at", "reason"}, map[string]any{"revision": text, "reviewed_at": text, "reason": text}),
		"WorkIntelRebuild":       object([]string{"from", "to", "reason"}, map[string]any{"from": day, "to": day, "reason": text}),
		"WorkIntelAutomationReview": object([]string{"review_status", "note"}, map[string]any{
			"review_status": map[string]any{"type": "string", "enum": []string{"new", "reviewing", "accepted", "dismissed"}}, "note": text,
		}),
	}
}
