package store

import (
	"context"
	"time"
)

// UserUsageTotals are aggregate counters for one user over a window.
type UserUsageTotals struct {
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	CostKRW  float64 `json:"cost_krw"`
	Errors   int64   `json:"errors"`
}

// UserModelCost is one model's usage + cost + reliability for a user.
type UserModelCost struct {
	Model       string  `json:"model"`
	Requests    int64   `json:"requests"`
	AvgCostKRW  float64 `json:"avg_cost_krw"`
	SuccessRate float64 `json:"success_rate"`
}

// UserFailure is a recent failed request for a user.
type UserFailure struct {
	ID         string `json:"id"`
	Model      string `json:"model"`
	StatusCode int    `json:"status_code"`
	Error      string `json:"error"`
	TaskType   string `json:"task_type"`
	CreatedAt  string `json:"created_at"`
}

// UserUsageTotalsSince returns a user's request/token/cost/error totals since `since`.
// Users are resolved through api_keys.user_id.
func (s *SQLStore) UserUsageTotalsSince(ctx context.Context, userID string, since time.Time) (UserUsageTotals, error) {
	var u UserUsageTotals
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(*),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 OR COALESCE(r.error, '') <> '' OR COALESCE(r.failover, 0) = 1 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE k.user_id = ? AND r.created_at >= ?`), userID, since.UTC().Format(time.RFC3339Nano)).
		Scan(&u.Requests, &u.Tokens, &u.CostKRW, &u.Errors)
	return u, err
}

// UserModelCosts returns per-model usage/cost/success for a user since `since`, busiest first.
func (s *SQLStore) UserModelCosts(ctx context.Context, userID string, since time.Time) ([]UserModelCost, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*),
			AVG(COALESCE(t.estimated_cost, 0)),
			AVG(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1.0 ELSE 0.0 END)
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE k.user_id = ? AND r.created_at >= ?
		GROUP BY COALESCE(NULLIF(r.model, ''), '(unknown)')
		ORDER BY COUNT(*) DESC`), userID, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserModelCost{}
	for rows.Next() {
		var m UserModelCost
		if err := rows.Scan(&m.Model, &m.Requests, &m.AvgCostKRW, &m.SuccessRate); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UserRecentFailures returns a user's most recent failed requests.
func (s *SQLStore) UserRecentFailures(ctx context.Context, userID string, limit int) ([]UserFailure, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.id, COALESCE(NULLIF(r.model, ''), '(unknown)'), r.status_code,
			COALESCE(r.error, ''), COALESCE(NULLIF(r.task_type, ''), 'other'), r.created_at
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		WHERE k.user_id = ? AND (r.status_code >= 400 OR COALESCE(r.error, '') <> '' OR COALESCE(r.failover, 0) = 1)
		ORDER BY r.created_at DESC
		LIMIT ?`), userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserFailure{}
	for rows.Next() {
		var f UserFailure
		if err := rows.Scan(&f.ID, &f.Model, &f.StatusCode, &f.Error, &f.TaskType, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PersonalRecommendation is one actionable suggestion for a user (e.g. switch model,
// adopt a template), generated from their own usage.
type PersonalRecommendation struct {
	ID            string  `json:"id"`
	UserID        string  `json:"user_id"`
	Kind          string  `json:"kind"`
	Title         string  `json:"title"`
	Detail        string  `json:"detail"`
	EstSavingsKRW float64 `json:"est_savings_krw"`
	CreatedAt     string  `json:"created_at"`
}

// ReplaceUserRecommendations atomically replaces a user's recommendation set.
func (s *SQLStore) ReplaceUserRecommendations(ctx context.Context, userID string, recs []PersonalRecommendation) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM personal_recommendations WHERE user_id = ?`), userID); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, rec := range recs {
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO personal_recommendations (id, user_id, kind, title, detail, est_savings_krw, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`), rec.ID, userID, rec.Kind, rec.Title, rec.Detail, rec.EstSavingsKRW, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListUserRecommendations returns a user's current recommendations.
func (s *SQLStore) ListUserRecommendations(ctx context.Context, userID string) ([]PersonalRecommendation, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, user_id, kind, title, COALESCE(detail, ''), est_savings_krw, created_at
		FROM personal_recommendations WHERE user_id = ? ORDER BY est_savings_krw DESC, created_at DESC`), userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PersonalRecommendation{}
	for rows.Next() {
		var rec PersonalRecommendation
		if err := rows.Scan(&rec.ID, &rec.UserID, &rec.Kind, &rec.Title, &rec.Detail, &rec.EstSavingsKRW, &rec.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}
