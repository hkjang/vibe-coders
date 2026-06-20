package store

import (
	"context"
	"strings"
	"time"
)

// TeamUsageTotals are aggregate counters for one team over a window.
type TeamUsageTotals struct {
	Requests     int64   `json:"requests"`
	Tokens       int64   `json:"tokens"`
	CostKRW      float64 `json:"cost_krw"`
	Errors       int64   `json:"errors"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	SuccessRate  float64 `json:"success_rate"`
}

// TeamUserUsage is one member's usage within the team.
type TeamUserUsage struct {
	UserID   string  `json:"user_id"`
	Requests int64   `json:"requests"`
	CostKRW  float64 `json:"cost_krw"`
	Errors   int64   `json:"errors"`
}

// TeamModelUsage is one model's usage within the team.
type TeamModelUsage struct {
	Model    string  `json:"model"`
	Requests int64   `json:"requests"`
	CostKRW  float64 `json:"cost_krw"`
}

// TeamDashboardData is the team_manager landing payload: team totals, top members, model
// mix, and recent failures — all scoped to the caller's team, no operational internals.
type TeamDashboardData struct {
	TeamKeys       []string        `json:"team_keys"`
	Totals         TeamUsageTotals `json:"totals"`
	TopUsers       []TeamUserUsage `json:"top_users"`
	Models         []TeamModelUsage `json:"models"`
	RecentFailures []UserFailure   `json:"recent_failures"`
}

// teamErrorExpr classifies a failed request consistently across the team queries.
const teamErrorExpr = `(r.status_code >= 400 OR COALESCE(r.error, '') <> '' OR COALESCE(r.failover, 0) = 1)`

// teamInClause builds "(requestTeamExpr) IN (?, ?, ...)" plus the bound args for a set of
// acceptable team identifiers (a team is stored on api_keys.team as id-or-name, so callers
// pass both their team id and name to match either).
func teamInClause(keys []string) (string, []any) {
	ph := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys))
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		ph = append(ph, "?")
		args = append(args, k)
	}
	if len(ph) == 0 {
		return "", nil
	}
	return requestTeamExpr + " IN (" + strings.Join(ph, ",") + ")", args
}

// TeamDashboardSince assembles the team dashboard for the given team identifiers since the
// cutoff. Returns zero-valued data (not an error) when keys is empty.
func (s *SQLStore) TeamDashboardSince(ctx context.Context, keys []string, since time.Time, limit int) (TeamDashboardData, error) {
	out := TeamDashboardData{TeamKeys: keys, TopUsers: []TeamUserUsage{}, Models: []TeamModelUsage{}, RecentFailures: []UserFailure{}}
	teamFilter, teamArgs := teamInClause(keys)
	if teamFilter == "" {
		return out, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	// Totals.
	totalsArgs := append([]any{sinceStr}, teamArgs...)
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(*),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN `+teamErrorExpr+` THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(r.latency_ms), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter), totalsArgs...).
		Scan(&out.Totals.Requests, &out.Totals.Tokens, &out.Totals.CostKRW, &out.Totals.Errors, &out.Totals.AvgLatencyMS)
	if err != nil {
		return out, err
	}
	if out.Totals.Requests > 0 {
		out.Totals.SuccessRate = float64(out.Totals.Requests-out.Totals.Errors) / float64(out.Totals.Requests)
	}

	// Top members.
	userArgs := append(append([]any{sinceStr}, teamArgs...), limit)
	urows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF((SELECT k.user_id FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unattributed') AS uid,
			COUNT(*),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN `+teamErrorExpr+` THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter+`
		GROUP BY uid ORDER BY COUNT(*) DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for urows.Next() {
		var u TeamUserUsage
		if err := urows.Scan(&u.UserID, &u.Requests, &u.CostKRW, &u.Errors); err != nil {
			urows.Close()
			return out, err
		}
		out.TopUsers = append(out.TopUsers, u)
	}
	urows.Close()
	if err := urows.Err(); err != nil {
		return out, err
	}

	// Model mix.
	mrows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter+`
		GROUP BY model ORDER BY COUNT(*) DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for mrows.Next() {
		var m TeamModelUsage
		if err := mrows.Scan(&m.Model, &m.Requests, &m.CostKRW); err != nil {
			mrows.Close()
			return out, err
		}
		out.Models = append(out.Models, m)
	}
	mrows.Close()
	if err := mrows.Err(); err != nil {
		return out, err
	}

	// Recent failures (team-scoped).
	frows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.id, COALESCE(NULLIF(r.model, ''), '(unknown)'), r.status_code,
			COALESCE(r.error, ''), COALESCE(NULLIF(r.task_type, ''), 'other'), r.created_at
		FROM request_logs r
		WHERE r.created_at >= ? AND `+teamFilter+` AND `+teamErrorExpr+`
		ORDER BY r.created_at DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for frows.Next() {
		var f UserFailure
		if err := frows.Scan(&f.ID, &f.Model, &f.StatusCode, &f.Error, &f.TaskType, &f.CreatedAt); err != nil {
			frows.Close()
			return out, err
		}
		out.RecentFailures = append(out.RecentFailures, f)
	}
	frows.Close()
	return out, frows.Err()
}
