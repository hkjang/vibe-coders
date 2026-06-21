package store

import (
	"context"
	"time"
)

// AIAppRun is one execution (or planned execution) of an AI work app. It stores only safe
// metadata — never the raw input or output (input_hash + output_summary only).
type AIAppRun struct {
	ID            string  `json:"id"`
	AppID         string  `json:"app_id"`
	UserID        string  `json:"user_id"`
	Team          string  `json:"team"`
	Status        string  `json:"status"` // planned | ok | error
	InputHash     string  `json:"input_hash"`
	OutputSummary string  `json:"output_summary"`
	ErrorClass    string  `json:"error_class"`
	LatencyMS     int64   `json:"latency_ms"`
	CostKRW       float64 `json:"cost_krw"`
	CreatedAt     string  `json:"created_at"`
}

// RecordAIAppRun persists one app run.
func (s *SQLStore) RecordAIAppRun(ctx context.Context, run AIAppRun) error {
	if run.CreatedAt == "" {
		run.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if run.Status == "" {
		run.Status = "planned"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO ai_app_runs
		(id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.AppID, run.UserID, run.Team, run.Status, run.InputHash, run.OutputSummary, run.ErrorClass, run.LatencyMS, run.CostKRW, run.CreatedAt)
	return err
}

// ListAIAppRuns returns runs for a user (required), optionally filtered by app, newest first.
func (s *SQLStore) ListAIAppRuns(ctx context.Context, userID, appID string, limit int) ([]AIAppRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, created_at
		FROM ai_app_runs WHERE user_id = ?`
	args := []any{userID}
	if appID != "" {
		q += ` AND app_id = ?`
		args = append(args, appID)
	}
	q += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIAppRun{}
	for rows.Next() {
		var a AIAppRun
		if err := rows.Scan(&a.ID, &a.AppID, &a.UserID, &a.Team, &a.Status, &a.InputHash, &a.OutputSummary, &a.ErrorClass, &a.LatencyMS, &a.CostKRW, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
