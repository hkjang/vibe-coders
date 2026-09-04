package store

import (
	"context"
	"strings"
	"time"
)

// MergeLLMRequestTeamScope appends the same request-to-API-key team boundary used
// by the request explorer to an LLM observability filter. The filter methods use
// request_logs as alias r. A required scope without a usable identity fails closed.
func MergeLLMRequestTeamScope(whereClause string, args []any, teams []string, teamScoped bool) (string, []any) {
	whereClause = strings.TrimSpace(whereClause)
	if whereClause == "" {
		whereClause = "1=1"
	}
	where := []string{"(" + whereClause + ")"}
	mergedArgs := append([]any(nil), args...)
	where, mergedArgs = appendRequestTeamCondition(where, mergedArgs, "", teams, teamScoped)
	return strings.Join(where, " AND "), mergedArgs
}

// SessionTimelineScoped returns only the requests in a session that belong to
// the caller's allowed teams. Session identifiers are client-controlled and can
// be shared across teams, so checking that a session exists is not sufficient.
func (s *SQLStore) SessionTimelineScoped(ctx context.Context, sessionID string, limit int, teams []string, teamScoped bool) (SessionTimeline, error) {
	if !routingDecisionTeamFilterRequested(teams, teamScoped) {
		return s.SessionTimeline(ctx, sessionID, limit)
	}
	timeline := SessionTimeline{SessionID: sessionID, Points: []SessionTimelinePoint{}}
	if limit <= 0 || limit > 2000 {
		limit = 1000
	}

	where := []string{"r.session_id = ?"}
	args := []any{sessionID}
	if sessionID == "no-session" {
		where = []string{"(r.session_id IS NULL OR r.session_id = '')"}
		args = nil
	}
	where, args = appendRequestTeamCondition(where, args, "", teams, teamScoped)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.id, r.trace_id, COALESCE(r.model, ''), COALESCE(r.provider, ''),
			COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'),
			COALESCE((
				SELECT COALESCE(NULLIF(pl.redacted_text, ''), pl.content_text)
				FROM prompt_logs pl
				WHERE pl.request_id = r.id AND LOWER(pl.role) = 'user'
				ORDER BY pl.created_at DESC
				LIMIT 1
			), ''),
			r.status_code, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
			COALESCE(t.total_tokens, 0), COALESCE(t.estimated_cost, 0),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.source = 'call'),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.is_error = 1),
			(SELECT COUNT(*) FROM llm_evaluations e WHERE e.request_id = r.id AND e.passed = 0),
			r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY r.created_at ASC
		LIMIT ?`), args...)
	if err != nil {
		return timeline, err
	}
	defer rows.Close()

	var cumulativeCost float64
	var cumulativeTokens int64
	var firstTimestamp, lastTimestamp string
	for rows.Next() {
		var point SessionTimelinePoint
		if err := rows.Scan(&point.RequestID, &point.TraceID, &point.Model, &point.Provider, &point.PromptName,
			&point.LastMessage, &point.StatusCode, &point.LatencyMS, &point.FirstChunkMS, &point.TotalTokens,
			&point.CostKRW, &point.ToolCalls, &point.ToolErrors, &point.EvalFailures, &point.CreatedAt); err != nil {
			return timeline, err
		}
		point.LastMessage = collapseLastMessage(point.LastMessage)
		cumulativeCost += point.CostKRW
		cumulativeTokens += point.TotalTokens
		point.CumulativeCostKRW = cumulativeCost
		point.CumulativeTokens = cumulativeTokens
		timeline.ToolCalls += point.ToolCalls
		if firstTimestamp == "" {
			firstTimestamp = point.CreatedAt
		}
		lastTimestamp = point.CreatedAt
		timeline.Points = append(timeline.Points, point)
	}
	if err := rows.Err(); err != nil {
		return timeline, err
	}

	timeline.Requests = len(timeline.Points)
	timeline.TotalCostKRW = cumulativeCost
	timeline.TotalTokens = cumulativeTokens
	if firstTimestamp != "" && lastTimestamp != "" {
		if first, err := time.Parse(time.RFC3339Nano, firstTimestamp); err == nil {
			if last, err := time.Parse(time.RFC3339Nano, lastTimestamp); err == nil {
				timeline.DurationSeconds = int64(last.Sub(first).Seconds())
			}
		}
	}
	return timeline, nil
}
