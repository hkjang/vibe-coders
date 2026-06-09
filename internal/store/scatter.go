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
	if f.Model != "" {
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
			r.stream, COALESCE(r.tool_count, 0), COALESCE(r.failover, 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
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
			&p.TotalTokens, &p.CostKRW, &streamInt, &p.ToolCount, &failoverInt); err != nil {
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
