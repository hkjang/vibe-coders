package store

import (
	"context"
	"time"
)

// ModelStat holds rolling per-model averages used to predict a call's cost/latency
// before it is sent upstream.
type ModelStat struct {
	Model           string  `json:"model"`
	AvgOutputTokens float64 `json:"avg_output_tokens"`
	AvgLatencyMS    float64 `json:"avg_latency_ms"`
	Samples         int64   `json:"samples"`
}

// ModelStats returns per-model average completion tokens and latency over chat
// completions since `since` (only requests that actually reported usage).
func (s *SQLStore) ModelStats(ctx context.Context, since time.Time) (map[string]ModelStat, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.model,
			AVG(COALESCE(t.completion_tokens, 0)) AS avg_out,
			AVG(r.latency_ms) AS avg_latency,
			COUNT(*) AS samples
		FROM request_logs r
		JOIN token_usage t ON t.request_id = r.id
		WHERE r.endpoint LIKE '%chat/completions%' AND r.created_at >= ?
			AND COALESCE(t.completion_tokens, 0) > 0 AND COALESCE(NULLIF(r.model, ''), '') <> ''
		GROUP BY r.model`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ModelStat{}
	for rows.Next() {
		var m ModelStat
		if err := rows.Scan(&m.Model, &m.AvgOutputTokens, &m.AvgLatencyMS, &m.Samples); err != nil {
			return nil, err
		}
		out[m.Model] = m
	}
	return out, rows.Err()
}
