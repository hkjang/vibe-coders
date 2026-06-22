package store

import (
	"context"
	"database/sql"
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
	TraceID       string  `json:"trace_id"`
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
		(id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, trace_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.AppID, run.UserID, run.Team, run.Status, run.InputHash, run.OutputSummary, run.ErrorClass, run.LatencyMS, run.CostKRW, run.TraceID, run.CreatedAt)
	return err
}

// GetAIAppRun returns one app run by id.
func (s *SQLStore) GetAIAppRun(ctx context.Context, id string) (AIAppRun, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, trace_id, created_at
		FROM ai_app_runs WHERE id = ?`), id)
	var a AIAppRun
	err := row.Scan(&a.ID, &a.AppID, &a.UserID, &a.Team, &a.Status, &a.InputHash, &a.OutputSummary, &a.ErrorClass, &a.LatencyMS, &a.CostKRW, &a.TraceID, &a.CreatedAt)
	if err == sql.ErrNoRows {
		return AIAppRun{}, false, nil
	}
	if err != nil {
		return AIAppRun{}, false, err
	}
	return a, true, nil
}

// ListAIAppRuns returns runs for a user (required), optionally filtered by app, newest first.
func (s *SQLStore) ListAIAppRuns(ctx context.Context, userID, appID string, limit int) ([]AIAppRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, trace_id, created_at
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
		if err := rows.Scan(&a.ID, &a.AppID, &a.UserID, &a.Team, &a.Status, &a.InputHash, &a.OutputSummary, &a.ErrorClass, &a.LatencyMS, &a.CostKRW, &a.TraceID, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AIAppRunsByTrace returns app runs that belong to a trace (newest first).
func (s *SQLStore) AIAppRunsByTrace(ctx context.Context, traceID string) ([]AIAppRun, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, app_id, user_id, team, status, input_hash, output_summary, error_class, latency_ms, cost_krw, trace_id, created_at
		FROM ai_app_runs WHERE trace_id = ? ORDER BY created_at DESC`), traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIAppRun{}
	for rows.Next() {
		var a AIAppRun
		if err := rows.Scan(&a.ID, &a.AppID, &a.UserID, &a.Team, &a.Status, &a.InputHash, &a.OutputSummary, &a.ErrorClass, &a.LatencyMS, &a.CostKRW, &a.TraceID, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
