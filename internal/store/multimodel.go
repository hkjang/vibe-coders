package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// MultiModelTestRun is one multi-model comparison execution (header).
type MultiModelTestRun struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	CreatedBy     string `json:"created_by"`
	Team          string `json:"team"`
	PromptHash    string `json:"prompt_hash"`
	PromptPreview string `json:"prompt_preview"`
	ModelCount    int    `json:"model_count"`
	Success       int    `json:"success"`
	Failed        int    `json:"failed"`
	CreatedAt     string `json:"created_at"`
}

// MultiModelTestResult is one model's outcome within a run.
type MultiModelTestResult struct {
	RunID           string  `json:"run_id"`
	Model           string  `json:"model"`
	Provider        string  `json:"provider"`
	Status          string  `json:"status"`
	StatusCode      int     `json:"status_code"`
	LatencyMS       int64   `json:"latency_ms"`
	InputTokens     int     `json:"input_tokens"`
	OutputTokens    int     `json:"output_tokens"`
	TotalTokens     int     `json:"total_tokens"`
	CostKRW         float64 `json:"cost_krw"`
	ResponsePreview string  `json:"response_preview"`
	ResponseHash    string  `json:"response_hash"`
	Error           string  `json:"error"`
	CreatedAt       string  `json:"created_at"`
}

// MultiModelTestFeedback is a human rating/comment on one model's response.
type MultiModelTestFeedback struct {
	ID        string `json:"id"`
	RunID     string `json:"run_id"`
	Model     string `json:"model"`
	Rating    int    `json:"rating"`
	Label     string `json:"label"`
	Comment   string `json:"comment"`
	CreatedBy string `json:"created_by"`
	CreatedAt string `json:"created_at"`
}

// SaveMultiModelRun persists a run header and its per-model results in one transaction.
func (s *SQLStore) SaveMultiModelRun(ctx context.Context, run MultiModelTestRun, results []MultiModelTestResult) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if run.CreatedAt == "" {
		run.CreatedAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO multi_model_test_runs
		(id, title, created_by, team, prompt_hash, prompt_preview, model_count, success, failed, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.Title, run.CreatedBy, run.Team, run.PromptHash, run.PromptPreview,
		run.ModelCount, run.Success, run.Failed, run.CreatedAt); err != nil {
		return err
	}
	for _, r := range results {
		if r.CreatedAt == "" {
			r.CreatedAt = run.CreatedAt
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO multi_model_test_results
			(run_id, model, provider, status, status_code, latency_ms, input_tokens, output_tokens, total_tokens, cost_krw, response_preview, response_hash, error, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			run.ID, r.Model, r.Provider, r.Status, r.StatusCode, r.LatencyMS, r.InputTokens, r.OutputTokens,
			r.TotalTokens, r.CostKRW, r.ResponsePreview, r.ResponseHash, r.Error, r.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListMultiModelRuns returns run headers, newest first.
func (s *SQLStore) ListMultiModelRuns(ctx context.Context, limit int) ([]MultiModelTestRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, title, created_by, team, prompt_hash, prompt_preview, model_count, success, failed, created_at
		FROM multi_model_test_runs ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MultiModelTestRun{}
	for rows.Next() {
		var r MultiModelTestRun
		if err := rows.Scan(&r.ID, &r.Title, &r.CreatedBy, &r.Team, &r.PromptHash, &r.PromptPreview, &r.ModelCount, &r.Success, &r.Failed, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetMultiModelRun returns a run header plus its results and feedback.
func (s *SQLStore) GetMultiModelRun(ctx context.Context, id string) (MultiModelTestRun, []MultiModelTestResult, []MultiModelTestFeedback, bool, error) {
	var run MultiModelTestRun
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, title, created_by, team, prompt_hash, prompt_preview, model_count, success, failed, created_at
		FROM multi_model_test_runs WHERE id = ?`), id).
		Scan(&run.ID, &run.Title, &run.CreatedBy, &run.Team, &run.PromptHash, &run.PromptPreview, &run.ModelCount, &run.Success, &run.Failed, &run.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return MultiModelTestRun{}, nil, nil, false, nil
	}
	if err != nil {
		return MultiModelTestRun{}, nil, nil, false, err
	}
	results := []MultiModelTestResult{}
	rrows, err := s.db.QueryContext(ctx, s.bind(`SELECT run_id, model, provider, status, status_code, latency_ms, input_tokens, output_tokens, total_tokens, cost_krw, response_preview, response_hash, error, created_at
		FROM multi_model_test_results WHERE run_id = ? ORDER BY latency_ms ASC`), id)
	if err != nil {
		return run, nil, nil, true, err
	}
	for rrows.Next() {
		var r MultiModelTestResult
		if err := rrows.Scan(&r.RunID, &r.Model, &r.Provider, &r.Status, &r.StatusCode, &r.LatencyMS, &r.InputTokens, &r.OutputTokens, &r.TotalTokens, &r.CostKRW, &r.ResponsePreview, &r.ResponseHash, &r.Error, &r.CreatedAt); err != nil {
			rrows.Close()
			return run, nil, nil, true, err
		}
		results = append(results, r)
	}
	rrows.Close()

	feedback := []MultiModelTestFeedback{}
	frows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, model, rating, label, comment, created_by, created_at
		FROM multi_model_test_feedback WHERE run_id = ? ORDER BY created_at DESC`), id)
	if err != nil {
		return run, results, nil, true, err
	}
	for frows.Next() {
		var f MultiModelTestFeedback
		if err := frows.Scan(&f.ID, &f.RunID, &f.Model, &f.Rating, &f.Label, &f.Comment, &f.CreatedBy, &f.CreatedAt); err != nil {
			frows.Close()
			return run, results, nil, true, err
		}
		feedback = append(feedback, f)
	}
	frows.Close()
	return run, results, feedback, true, nil
}

// InsertMultiModelFeedback records a human rating/comment for a model in a run.
func (s *SQLStore) InsertMultiModelFeedback(ctx context.Context, f MultiModelTestFeedback) error {
	if f.CreatedAt == "" {
		f.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO multi_model_test_feedback
		(id, run_id, model, rating, label, comment, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		f.ID, f.RunID, f.Model, f.Rating, f.Label, f.Comment, f.CreatedBy, f.CreatedAt)
	return err
}
