package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

const scatterSelect = `
	SELECT r.id, r.trace_id, r.created_at, r.ingested_at, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
		r.status_code, COALESCE(r.provider, ''), COALESCE(r.model, ''), r.endpoint,
		COALESCE(t.total_tokens, 0), COALESCE(t.estimated_cost, 0),
		r.stream, COALESCE(r.tool_count, 0), COALESCE(r.failover, 0),
		COALESCE(r.complexity, 0), COALESCE(rd.risk_score, 0), COALESCE(rd.health_score, 0), COALESCE(rd.decision_reason, ''),
		COALESCE((SELECT COUNT(*) FROM policy_decision_events pde WHERE pde.request_id = r.id AND LOWER(pde.decision) <> 'default'), 0),
		COALESCE((
			SELECT pde.decision FROM policy_decision_events pde
			WHERE pde.request_id = r.id
			  AND LOWER(pde.decision) <> 'default'
			ORDER BY CASE
				WHEN pde.decision = 'block' THEN 1
				WHEN pde.decision LIKE 'deny_%' THEN 2
				WHEN pde.decision = 'require_approval' THEN 3
				WHEN pde.decision = 'mask' THEN 4
				ELSE 5
			END, pde.created_at DESC
			LIMIT 1
		), ''),
		COALESCE((SELECT COUNT(*) FROM approvals a WHERE a.request_id = r.id), 0),
		COALESCE((
			SELECT a.status FROM approvals a
			WHERE a.request_id = r.id
			ORDER BY CASE a.status
				WHEN 'rejected' THEN 1
				WHEN 'expired' THEN 2
				WHEN 'pending' THEN 3
				WHEN 'approved' THEN 4
				ELSE 5
			END, a.created_at DESC
			LIMIT 1
		), ''),
		COALESCE((SELECT COUNT(*) FROM secret_events se WHERE se.request_id = r.id), 0),
		COALESCE((
			SELECT se.action FROM secret_events se
			WHERE se.request_id = r.id
			ORDER BY CASE se.action
				WHEN 'block' THEN 1
				WHEN 'mask' THEN 2
				WHEN 'detect' THEN 3
				ELSE 4
			END, se.created_at DESC
			LIMIT 1
		), '')
	FROM request_logs r
	LEFT JOIN token_usage t ON t.request_id = r.id
	LEFT JOIN routing_decisions rd ON rd.request_id = r.id`

// New InsertLogRecord transactions receive their timestamp from a database-locked monotonic
// clock immediately before commit, so their forward cursor is lossless across pods. A short
// overlap remains useful for mutable governance metadata and for rows written with the empty
// default by older binaries during a rolling upgrade. Responses may repeat request ids.
const (
	scatterDeltaReconcileWindow = 30 * time.Second
	scatterDeltaReconcileLimit  = 6000
	scatterDeltaRefreshLimit    = 6000
)

// scatterConditions is shared by the snapshot and incremental XView queries. Keeping the
// filters in one place prevents live mode from showing rows that the static view would hide.
func scatterConditions(f ScatterFilter) ([]string, []any) {
	where := []string{"r.created_at >= ?"}
	args := []any{f.Since.UTC().Format(time.RFC3339Nano)}
	if !f.Until.IsZero() {
		where = append(where, "r.created_at <= ?")
		args = append(args, f.Until.UTC().Format(time.RFC3339Nano))
	}
	if f.Endpoint != "" {
		where = append(where, "r.endpoint = ?")
		args = append(args, f.Endpoint)
	}
	switch {
	case len(f.Models) == 1:
		where = append(where, "r.model = ?")
		args = append(args, f.Models[0])
	case len(f.Models) > 1:
		placeholders := strings.Repeat(",?", len(f.Models))[1:]
		where = append(where, "r.model IN ("+placeholders+")")
		for _, model := range f.Models {
			args = append(args, model)
		}
	case f.Model != "":
		where = append(where, "r.model = ?")
		args = append(args, f.Model)
	}
	if f.APIKeyID != "" {
		where = append(where, "r.api_key_id = ?")
		args = append(args, f.APIKeyID)
	}
	where, args = appendRequestTeamCondition(where, args, f.Team, f.Teams, f.TeamScoped)
	return where, args
}

// appendRequestTeamCondition keeps request queries inside the caller's team boundary.
// Authentication uses a canonical team id while api_keys.team supports either that id or
// a validated display name, so callers pass both identities. Scoped identities always use
// a semi-join: the literal "unassigned" can be a real team id/name and must not include
// synthetic traffic whose API key is missing. The semi-join also lets XView use its
// composite request-log index instead of walking every tenant row.
func appendRequestTeamCondition(where []string, args []any, team string, teams []string, scoped bool) ([]string, []any) {
	return appendRequestTeamConditionWithPredicates(where, args, team, teams, scoped, "", "", false)
}

// appendRequestTeamConditionWithPredicates optionally adds bounded-key guards
// to both sides of the API-key semi-join. The React request projection uses
// these guards to match its partial indexes and fail closed on corrupt legacy
// identifiers; existing request queries retain their historical semantics.
func appendRequestTeamConditionWithPredicates(where []string, args []any, team string, teams []string, scoped bool, requestKeyPredicate, keyRowPredicate string, correlated bool) ([]string, []any) {
	keys := make([]string, 0, len(teams)+1)
	seen := make(map[string]struct{}, len(teams)+1)
	candidates := teams
	if !scoped {
		candidates = append([]string{team}, teams...)
	}
	for _, key := range candidates {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	if scoped && len(keys) == 0 {
		return append(where, "1 = 0"), args
	}
	if len(keys) == 0 {
		return where, args
	}
	placeholders := strings.Repeat(",?", len(keys))[1:]
	if !scoped && len(teams) == 0 && strings.TrimSpace(team) == "unassigned" {
		where = append(where, requestTeamExpr+" IN ("+placeholders+")")
	} else {
		if requestKeyPredicate != "" {
			where = append(where, requestKeyPredicate)
		}
		keyFilter := "k.team IN (" + placeholders + ")"
		if keyRowPredicate != "" {
			keyFilter += " AND " + keyRowPredicate
		}
		if correlated {
			where = append(where, "EXISTS (SELECT 1 FROM api_keys k WHERE k.id = r.api_key_id AND "+keyFilter+")")
		} else {
			where = append(where, "r.api_key_id IN (SELECT k.id FROM api_keys k WHERE "+keyFilter+")")
		}
	}
	for _, key := range keys {
		args = append(args, key)
	}
	return where, args
}

// ScatterPoints returns individual request points for a response-time scatter plot
// (XView). Each row is one transaction; the caller plots time on X and latency on Y
// and colors by category. Results are capped at filter.Limit (most recent first).
func (s *SQLStore) ScatterPoints(ctx context.Context, f ScatterFilter) ([]ScatterPoint, bool, error) {
	limit := f.Limit
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	where, args := scatterConditions(f)
	return s.queryScatterPoints(ctx, where, args, "r.created_at DESC", limit)
}

// LatestScatterCursor returns the high-water mark of committed request rows. Callers take
// this before a snapshot query: rows committed between the cursor read and the snapshot may
// be returned twice, but request-id deduplication is safe, while taking it afterwards could
// skip a row that committed between the two reads.
func (s *SQLStore) LatestScatterCursor(ctx context.Context, f ScatterFilter) (ScatterCursor, error) {
	var cursor ScatterCursor
	where := []string{"r.ingested_at <> ''"}
	args := []any{}
	if f.TeamScoped || f.Team != "" || len(f.Teams) > 0 {
		// A team-scoped high-water query must not scan every other tenant's history on each
		// 1.5-second poll. Bound it to the visible time range and use the team cursor index.
		where = append(where, "r.created_at >= ?")
		args = append(args, f.Since.UTC().Format(time.RFC3339Nano))
		if !f.Until.IsZero() {
			where = append(where, "r.created_at <= ?")
			args = append(args, f.Until.UTC().Format(time.RFC3339Nano))
		}
		where, args = appendRequestTeamCondition(where, args, f.Team, f.Teams, f.TeamScoped)
	}
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT ingested_at, id
		FROM request_logs r
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY ingested_at DESC, id DESC
		LIMIT 1`), args...).Scan(&cursor.IngestedAt, &cursor.RequestID)
	if err == sql.ErrNoRows {
		return ScatterCursor{}, nil
	}
	return cursor, err
}

// ScatterDelta returns rows around a persistence cursor. The cursor is independent from request
// CreatedAt, so a slow request that starts earlier and reaches persistence later follows the
// current snapshot. Reconciliation repeats a bounded compatibility overlap, while refresh
// reprojects the visible window so mutable child records (for example approval decisions)
// update without a page reload. Callers must deduplicate RequestID. A zero cursor is a baseline
// call; subsequent calls return oldest-first forward pages.
func (s *SQLStore) ScatterDelta(ctx context.Context, f ScatterFilter, after time.Time, afterRequestID string, reconcile, refresh bool) ([]ScatterPoint, ScatterCursor, bool, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}

	where, args := scatterConditions(f)
	highWater, err := s.LatestScatterCursor(ctx, f)
	if err != nil {
		return nil, ScatterCursor{}, false, err
	}
	if after.IsZero() {
		// A snapshot normally supplies a cursor, so this path is mainly the empty-database
		// bootstrap. Read oldest-first and preserve has_more: if more than one page arrives
		// between the empty snapshot and the first poll, returning only the newest page would
		// silently skip the earlier requests.
		baselineWhere := append(append([]string{}, where...), "r.ingested_at <> ''")
		points, hasMore, err := s.queryScatterPoints(ctx, baselineWhere, args, "r.ingested_at ASC, r.id ASC", limit)
		if err != nil {
			return nil, ScatterCursor{}, false, err
		}
		cursor := ScatterCursor{}
		if len(points) > 0 {
			cursor = cursorForScatterPoint(points[len(points)-1])
		}
		if !hasMore {
			cursor = laterScatterCursor(cursor, highWater)
		}
		if refresh {
			refreshed, _, err := s.queryScatterPoints(ctx, where, args, "r.created_at DESC, r.id DESC", scatterDeltaRefreshLimit)
			if err != nil {
				return nil, ScatterCursor{}, false, err
			}
			points = mergeScatterPoints(refreshed, points)
		} else if reconcile {
			// An empty database can receive writes from an older pod before this version writes
			// its first cursor-bearing row. Include the newest compatibility rows without trying
			// to make their empty ingestion timestamp advance the cursor.
			legacyWhere, legacyArgs := scatterConditions(f)
			legacyWhere = append(legacyWhere, "r.ingested_at = ''")
			legacy, _, err := s.queryScatterPoints(ctx, legacyWhere, legacyArgs, "r.created_at DESC, r.id DESC", scatterDeltaReconcileLimit)
			if err != nil {
				return nil, ScatterCursor{}, false, err
			}
			points = mergeScatterPoints(legacy, points)
		}
		return points, cursor, hasMore, nil
	}

	normalizedAfter := formatXViewIngestedAt(after)
	where = append(where, "(r.ingested_at > ? OR (r.ingested_at = ? AND r.id > ?))")
	args = append(args, normalizedAfter, normalizedAfter, afterRequestID)
	forwardPoints, hasMore, err := s.queryScatterPoints(ctx, where, args, "r.ingested_at ASC, r.id ASC", limit)
	if err != nil {
		return nil, ScatterCursor{}, false, err
	}

	points := forwardPoints
	if refresh {
		// Approval decisions and other governance records can change long after their parent
		// request was ingested. A deliberately infrequent bounded reprojection keeps those
		// fields current without making every forward poll execute the full scatter projection.
		refreshWhere, refreshArgs := scatterConditions(f)
		refreshed, _, err := s.queryScatterPoints(ctx, refreshWhere, refreshArgs, "r.created_at DESC, r.id DESC", scatterDeltaRefreshLimit)
		if err != nil {
			return nil, ScatterCursor{}, false, err
		}
		points = mergeScatterPoints(refreshed, forwardPoints)
	} else if reconcile {
		// Reconcile recently timestamped rows at or behind the cursor. A transaction on another
		// connection may have received its ingested_at first but committed after a later transaction
		// advanced the client's cursor. The exact cursor row is omitted, while other repeats are
		// deliberate and are removed by request_id in the UI. This is explicitly opt-in so normal
		// 1.5-second polls do not repeat the expensive scatter projection over the overlap window.
		reconcileWhere, reconcileArgs := scatterConditions(f)
		reconcileStart := formatXViewIngestedAt(after.Add(-scatterDeltaReconcileWindow))
		reconcileWhere = append(reconcileWhere,
			"r.ingested_at >= ?",
			"(r.ingested_at < ? OR (r.ingested_at = ? AND r.id <= ?))",
			"r.id <> ?",
		)
		reconcileArgs = append(reconcileArgs, reconcileStart, normalizedAfter, normalizedAfter, afterRequestID, afterRequestID)
		reconciled, _, err := s.queryScatterPoints(ctx, reconcileWhere, reconcileArgs, "r.ingested_at ASC, r.id ASC", scatterDeltaReconcileLimit)
		if err != nil {
			return nil, ScatterCursor{}, false, err
		}
		points = mergeScatterPoints(reconciled, forwardPoints)

		// During a rolling upgrade, an older gateway can still insert rows without the new
		// column and receive its empty default. Surface the newest full UI window while those
		// binaries remain in the rolling deployment. The indexed equality is cheap once the
		// fleet is fully upgraded, and request-id deduplication makes repeats harmless.
		legacyWhere, legacyArgs := scatterConditions(f)
		legacyWhere = append(legacyWhere, "r.ingested_at = ''")
		legacy, _, err := s.queryScatterPoints(ctx, legacyWhere, legacyArgs, "r.created_at DESC, r.id DESC", scatterDeltaReconcileLimit)
		if err != nil {
			return nil, ScatterCursor{}, false, err
		}
		points = mergeScatterPoints(legacy, points)
	}

	cursor := ScatterCursor{IngestedAt: normalizedAfter, RequestID: afterRequestID}
	// Only forward rows may advance the cursor; reconciled rows are intentionally behind it.
	if len(forwardPoints) > 0 {
		cursor = cursorForScatterPoint(forwardPoints[len(forwardPoints)-1])
	}
	// When the matching page is exhausted, advance across committed non-matching rows too.
	// Otherwise a sparse model/endpoint filter would rescan the same global ingest interval
	// on every poll. Do not jump on a full page: another matching row may still be between the
	// last returned point and the high-water mark.
	if !hasMore {
		cursor = laterScatterCursor(cursor, highWater)
	}
	return points, cursor, hasMore, nil
}

func mergeScatterPoints(older, newer []ScatterPoint) []ScatterPoint {
	result := make([]ScatterPoint, 0, len(older)+len(newer))
	seen := make(map[string]struct{}, len(older)+len(newer))
	for _, points := range [][]ScatterPoint{older, newer} {
		for _, point := range points {
			if _, exists := seen[point.RequestID]; exists {
				continue
			}
			seen[point.RequestID] = struct{}{}
			result = append(result, point)
		}
	}
	return result
}

func (s *SQLStore) queryScatterPoints(ctx context.Context, where []string, args []any, order string, limit int) ([]ScatterPoint, bool, error) {
	queryArgs := append(append([]any{}, args...), limit+1)
	query := s.bind(scatterSelect + `
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY ` + order + `
		LIMIT ?`)

	rows, err := s.db.QueryContext(ctx, query, queryArgs...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	result := []ScatterPoint{}
	for rows.Next() {
		var point ScatterPoint
		var streamInt, failoverInt int
		if err := rows.Scan(&point.RequestID, &point.TraceID, &point.CreatedAt, &point.IngestedAt, &point.LatencyMS, &point.FirstChunkMS,
			&point.StatusCode, &point.Provider, &point.Model, &point.Endpoint,
			&point.TotalTokens, &point.CostKRW, &streamInt, &point.ToolCount, &failoverInt,
			&point.Complexity, &point.RiskScore, &point.HealthScore, &point.DecisionReason,
			&point.PolicyDecisionCount, &point.PolicyDecision, &point.ApprovalCount, &point.ApprovalStatus,
			&point.SecretEventCount, &point.SecretAction); err != nil {
			return nil, false, err
		}
		point.Stream = streamInt == 1
		point.Failover = failoverInt == 1
		result = append(result, point)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := false
	if len(result) > limit {
		result = result[:limit]
		truncated = true
	}
	return result, truncated, nil
}

func cursorForScatterPoint(point ScatterPoint) ScatterCursor {
	return ScatterCursor{IngestedAt: point.IngestedAt, RequestID: point.RequestID}
}

func laterScatterCursor(left, right ScatterCursor) ScatterCursor {
	if right.IngestedAt > left.IngestedAt || (right.IngestedAt == left.IngestedAt && right.RequestID > left.RequestID) {
		return right
	}
	return left
}
