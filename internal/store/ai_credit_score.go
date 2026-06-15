package store

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

// AICreditScore is a per-subject (API key / project / model / ...) "credit" rating that
// blends reliability (success rate) and cost efficiency over a window. Higher is better.
// It is a read-only operational signal — nothing enforces on it.
type AICreditScore struct {
	Subject     string  `json:"subject"`
	Requests    int64   `json:"requests"`
	Errors      int64   `json:"errors"`
	CostKRW     float64 `json:"cost_krw"`
	SuccessRate float64 `json:"success_rate"`
	CostPerReq  float64 `json:"cost_per_request"`
	Score       int     `json:"score"`      // 0..100
	Confidence  string  `json:"confidence"` // "low" when sample is small
}

// AICreditScores rates each subject of a dimension over the window. Score is
// round(100 * (0.7*reliability + 0.3*efficiency)) where reliability = success rate and
// efficiency is the subject's cost-per-request scaled against the worst in the set
// (cheapest → 1, most expensive → 0). Subjects with < 5 requests are flagged low
// confidence. Weights are intentionally simple and documented; tune as needed.
func (s *SQLStore) AICreditScores(ctx context.Context, dimension string, since time.Time, limit int) ([]AICreditScore, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported credit-score dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COUNT(r.id),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY COUNT(r.id) DESC
		LIMIT %d
	`, col, col, limit))

	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AICreditScore{}
	maxCostPerReq := 0.0
	for rows.Next() {
		var c AICreditScore
		if err := rows.Scan(&c.Subject, &c.Requests, &c.Errors, &c.CostKRW); err != nil {
			return nil, err
		}
		if c.Requests > 0 {
			c.SuccessRate = 1 - float64(c.Errors)/float64(c.Requests)
			c.CostPerReq = c.CostKRW / float64(c.Requests)
		}
		if c.CostPerReq > maxCostPerReq {
			maxCostPerReq = c.CostPerReq
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		efficiency := 1.0
		if maxCostPerReq > 0 {
			efficiency = 1 - out[i].CostPerReq/maxCostPerReq
		}
		score := 100 * (0.7*out[i].SuccessRate + 0.3*efficiency)
		out[i].Score = int(math.Round(math.Max(0, math.Min(100, score))))
		if out[i].Requests < 5 {
			out[i].Confidence = "low"
		} else {
			out[i].Confidence = "ok"
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Requests > out[j].Requests
	})
	return out, nil
}
