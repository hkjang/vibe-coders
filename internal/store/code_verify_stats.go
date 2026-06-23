package store

import (
	"context"
	"time"
)

// CodeVerifyModelStat aggregates persisted code verification verdicts for one model — a
// cross-request, accumulated complement to the per-run multi-model leaderboard.
type CodeVerifyModelStat struct {
	Model          string  `json:"model"`
	Verdicts       int     `json:"verdicts"`
	RiskHigh       int     `json:"risk_high"`
	RiskMedium     int     `json:"risk_medium"`
	RiskLow        int     `json:"risk_low"`
	HighFindings   int     `json:"high_findings"`
	MediumFindings int     `json:"medium_findings"`
	SecretFindings int     `json:"secret_findings"`
	Testable       int     `json:"testable"`
	Blocks         int     `json:"blocks"`
	HighRiskRate   float64 `json:"high_risk_rate"` // share of verdicts that were high risk
}

// CodeVerifyModelStats groups code verdicts by the originating request's model since a cutoff.
// Only code-bearing responses are counted. Ordered by high-risk verdicts then volume.
func (s *SQLStore) CodeVerifyModelStats(ctx context.Context, since time.Time, limit int) ([]CodeVerifyModelStat, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*),
			COALESCE(SUM(CASE WHEN cv.risk = 'high' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN cv.risk = 'medium' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN cv.risk = 'low' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(cv.high_count), 0),
			COALESCE(SUM(cv.medium_count), 0),
			COALESCE(SUM(cv.secret_count), 0),
			COALESCE(SUM(cv.testable_count), 0),
			COALESCE(SUM(cv.block_count), 0)
		FROM code_verify_results cv
		JOIN request_logs r ON cv.request_id = r.id
		WHERE cv.has_code = 1 AND r.created_at >= ?
		GROUP BY COALESCE(NULLIF(r.model, ''), '(unknown)')
		ORDER BY COALESCE(SUM(CASE WHEN cv.risk = 'high' THEN 1 ELSE 0 END), 0) DESC, COUNT(*) DESC
		LIMIT ?
	`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CodeVerifyModelStat{}
	for rows.Next() {
		var c CodeVerifyModelStat
		if err := rows.Scan(&c.Model, &c.Verdicts, &c.RiskHigh, &c.RiskMedium, &c.RiskLow,
			&c.HighFindings, &c.MediumFindings, &c.SecretFindings, &c.Testable, &c.Blocks); err != nil {
			return nil, err
		}
		if c.Verdicts > 0 {
			c.HighRiskRate = float64(c.RiskHigh) / float64(c.Verdicts)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
