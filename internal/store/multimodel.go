package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
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

// MMJudgementRow is a flattened judgement joined to its run, for leaderboard aggregation.
type MMJudgementRow struct {
	RunID      string  `json:"run_id"`
	Team       string  `json:"team"`
	Model      string  `json:"model"`
	TotalScore float64 `json:"total_score"`
	Verdict    string  `json:"verdict"`
}

// MultiModelJudgementRows returns judgements joined to their run, optionally filtered by team
// and a created-at floor (RFC3339; empty = all time). Powers the model leaderboard ("which
// model keeps winning").
func (s *SQLStore) MultiModelJudgementRows(ctx context.Context, team, sinceRFC string) ([]MMJudgementRow, error) {
	q := `SELECT j.run_id, COALESCE(r.team,''), j.model, j.total_score, j.verdict
		FROM multi_model_test_judgements j JOIN multi_model_test_runs r ON r.id = j.run_id`
	conds := []string{}
	args := []any{}
	if strings.TrimSpace(team) != "" {
		conds = append(conds, "r.team = ?")
		args = append(args, team)
	}
	if strings.TrimSpace(sinceRFC) != "" {
		conds = append(conds, "r.created_at >= ?")
		args = append(args, sinceRFC)
	}
	if len(conds) > 0 {
		q += " WHERE " + strings.Join(conds, " AND ")
	}
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MMJudgementRow{}
	for rows.Next() {
		var r MMJudgementRow
		if err := rows.Scan(&r.RunID, &r.Team, &r.Model, &r.TotalScore, &r.Verdict); err != nil {
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

// MultiModelTestPromotion is a "best model" promoted from a comparison run to a routing-rule
// DRAFT candidate (status stays "draft" — never auto-applied).
type MultiModelTestPromotion struct {
	ID            string `json:"id"`
	RunID         string `json:"run_id"`
	SelectedModel string `json:"selected_model"`
	TaskType      string `json:"task_type"`
	Reason        string `json:"reason"`
	Status        string `json:"status"`
	CreatedBy     string `json:"created_by"`
	CreatedAt     string `json:"created_at"`
}

// InsertMultiModelPromotion records a routing-rule draft candidate from a comparison run.
func (s *SQLStore) InsertMultiModelPromotion(ctx context.Context, p MultiModelTestPromotion) error {
	if p.CreatedAt == "" {
		p.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if p.Status == "" {
		p.Status = "draft"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO multi_model_test_promotions
		(id, run_id, selected_model, task_type, reason, status, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		p.ID, p.RunID, p.SelectedModel, p.TaskType, p.Reason, p.Status, p.CreatedBy, p.CreatedAt)
	return err
}

// ListMultiModelPromotions returns the draft routing candidates for a run.
func (s *SQLStore) ListMultiModelPromotions(ctx context.Context, runID string) ([]MultiModelTestPromotion, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, selected_model, task_type, reason, status, created_by, created_at
		FROM multi_model_test_promotions WHERE run_id = ? ORDER BY created_at DESC`), runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MultiModelTestPromotion{}
	for rows.Next() {
		var p MultiModelTestPromotion
		if err := rows.Scan(&p.ID, &p.RunID, &p.SelectedModel, &p.TaskType, &p.Reason, &p.Status, &p.CreatedBy, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
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

// MultiModelTestJudgement is an automated rubric score for one model's response within a run.
type MultiModelTestJudgement struct {
	ID             string  `json:"id"`
	RunID          string  `json:"run_id"`
	Model          string  `json:"model"`
	Method         string  `json:"method"`      // rule | model
	JudgeModel     string  `json:"judge_model"` // populated for method=model
	Rubric         string  `json:"rubric"`
	Accuracy       float64 `json:"accuracy"`
	Completeness   float64 `json:"completeness"`
	FormatScore    float64 `json:"format_score"`
	Safety         float64 `json:"safety"`
	CostEfficiency float64 `json:"cost_efficiency"`
	TotalScore     float64 `json:"total_score"`
	Verdict        string  `json:"verdict"`
	ReasonSummary  string  `json:"reason_summary"`
	ResponseHash   string  `json:"response_hash"`
	CreatedBy      string  `json:"created_by"`
	CreatedAt      string  `json:"created_at"`
}

// ReplaceMultiModelJudgements deletes prior judgements for a run and inserts the new set in one
// transaction (a run carries only its latest judgement pass).
func (s *SQLStore) ReplaceMultiModelJudgements(ctx context.Context, runID string, js []MultiModelTestJudgement) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM multi_model_test_judgements WHERE run_id = ?`), runID); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, j := range js {
		if j.CreatedAt == "" {
			j.CreatedAt = now
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO multi_model_test_judgements
			(id, run_id, model, method, judge_model, rubric, accuracy, completeness, format_score, safety,
			 cost_efficiency, total_score, verdict, reason_summary, response_hash, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			j.ID, j.RunID, j.Model, j.Method, j.JudgeModel, j.Rubric, j.Accuracy, j.Completeness, j.FormatScore, j.Safety,
			j.CostEfficiency, j.TotalScore, j.Verdict, j.ReasonSummary, j.ResponseHash, j.CreatedBy, j.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListMultiModelJudgements returns the stored judgements for a run, highest total first.
func (s *SQLStore) ListMultiModelJudgements(ctx context.Context, runID string) ([]MultiModelTestJudgement, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, model, method, judge_model, rubric,
		accuracy, completeness, format_score, safety, cost_efficiency, total_score, verdict, reason_summary,
		response_hash, created_by, created_at
		FROM multi_model_test_judgements WHERE run_id = ? ORDER BY total_score DESC`), runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MultiModelTestJudgement{}
	for rows.Next() {
		var j MultiModelTestJudgement
		if err := rows.Scan(&j.ID, &j.RunID, &j.Model, &j.Method, &j.JudgeModel, &j.Rubric,
			&j.Accuracy, &j.Completeness, &j.FormatScore, &j.Safety, &j.CostEfficiency, &j.TotalScore,
			&j.Verdict, &j.ReasonSummary, &j.ResponseHash, &j.CreatedBy, &j.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
