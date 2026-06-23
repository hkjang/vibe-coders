package store

import (
	"context"
	"time"
)

// GovernanceSimContext is a lightweight reconstruction of one historical request's
// governance-relevant attributes, used by the policy simulator to replay candidate
// rules against real traffic.
type GovernanceSimContext struct {
	APIKeyID        string  `json:"api_key_id"`
	TeamID          string  `json:"team_id"`
	Model           string  `json:"model"`
	Provider        string  `json:"provider"`
	ComplexityScore int     `json:"complexity_score"`
	RiskScore       int     `json:"risk_score"`
	StatusCode      int     `json:"status_code"`
	CostKRW         float64 `json:"cost_krw"`
}

// GovernanceSimContexts returns recent request contexts (model/provider/complexity/
// risk/team) for the policy simulator, newest first.
func (s *SQLStore) GovernanceSimContexts(ctx context.Context, since time.Time, limit int) ([]GovernanceSimContext, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(r.api_key_id, ''), COALESCE(k.team, ''), COALESCE(r.model, ''),
			COALESCE(r.provider, ''), COALESCE(r.complexity, 0), COALESCE(rd.risk_score, 0),
			COALESCE(r.status_code, 0), COALESCE(t.estimated_cost, 0)
		FROM request_logs r
		LEFT JOIN api_keys k ON k.id = r.api_key_id
		LEFT JOIN routing_decisions rd ON rd.request_id = r.id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		ORDER BY r.created_at DESC
		LIMIT ?`), since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GovernanceSimContext{}
	for rows.Next() {
		var c GovernanceSimContext
		if err := rows.Scan(&c.APIKeyID, &c.TeamID, &c.Model, &c.Provider, &c.ComplexityScore, &c.RiskScore, &c.StatusCode, &c.CostKRW); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
