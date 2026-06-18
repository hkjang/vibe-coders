package store

import (
	"context"
	"strings"
	"time"
)

// ScatterPoints returns individual request points for a response-time scatter plot
// (XView). Each row is one transaction; the caller plots time on X and latency on Y
// and colors by category. Results are capped at filter.Limit (most recent first).
func (s *SQLStore) ScatterPoints(ctx context.Context, f ScatterFilter) ([]ScatterPoint, bool, error) {
	limit := f.Limit
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	where := []string{"r.created_at >= ?"}
	args := []any{f.Since.UTC().Format(time.RFC3339Nano)}
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
		for _, m := range f.Models {
			args = append(args, m)
		}
	case f.Model != "":
		where = append(where, "r.model = ?")
		args = append(args, f.Model)
	}
	if f.APIKeyID != "" {
		where = append(where, "r.api_key_id = ?")
		args = append(args, f.APIKeyID)
	}
	// fetch limit+1 to detect truncation
	args = append(args, limit+1)

	query := s.bind(`
		SELECT r.id, r.trace_id, r.created_at, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
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
		LEFT JOIN routing_decisions rd ON rd.request_id = r.id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY r.created_at DESC
		LIMIT ?`)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	result := []ScatterPoint{}
	for rows.Next() {
		var p ScatterPoint
		var streamInt, failoverInt int
		if err := rows.Scan(&p.RequestID, &p.TraceID, &p.CreatedAt, &p.LatencyMS, &p.FirstChunkMS,
			&p.StatusCode, &p.Provider, &p.Model, &p.Endpoint,
			&p.TotalTokens, &p.CostKRW, &streamInt, &p.ToolCount, &failoverInt,
			&p.Complexity, &p.RiskScore, &p.HealthScore, &p.DecisionReason,
			&p.PolicyDecisionCount, &p.PolicyDecision, &p.ApprovalCount, &p.ApprovalStatus,
			&p.SecretEventCount, &p.SecretAction); err != nil {
			return nil, false, err
		}
		p.Stream = streamInt == 1
		p.Failover = failoverInt == 1
		result = append(result, p)
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
