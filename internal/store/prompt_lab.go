package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PromptExperiment groups related prompt test cases by project/team/owner.
type PromptExperiment struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Team        string `json:"team"`
	Owner       string `json:"owner"`
	Status      string `json:"status"` // active | archived
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// PromptRubric is a reusable scoring rubric (criteria captured as free JSON).
type PromptRubric struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	CriteriaJSON string `json:"criteria_json"`
	CreatedBy    string `json:"created_by"`
	CreatedAt    string `json:"created_at"`
}

// PromptContract is an output-format contract a response must satisfy.
type PromptContract struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"` // json_schema | markdown_table | sql | regex | json
	SchemaJSON string `json:"schema_json"`
	Strict     bool   `json:"strict"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  string `json:"created_at"`
}

// PromptTestCase is a saved prompt (messages) tied to an experiment, with optional rubric +
// contract + a default model set, re-runnable for regression comparison.
type PromptTestCase struct {
	ID           string `json:"id"`
	ExperimentID string `json:"experiment_id"`
	Name         string `json:"name"`
	MessagesJSON string `json:"messages_json"`
	MessagesHash string `json:"messages_hash"`
	RubricID     string `json:"rubric_id"`
	ContractID   string `json:"contract_id"`
	ModelsJSON   string `json:"models_json"`
	CreatedBy    string `json:"created_by"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

// PromptTestCaseRun records one execution of a test case (linked to a multi-model run) with
// summary metrics, for regression history.
type PromptTestCaseRun struct {
	ID               string  `json:"id"`
	TestCaseID       string  `json:"test_case_id"`
	RunID            string  `json:"run_id"` // multi_model_test_runs.id
	BestModel        string  `json:"best_model"`
	AvgScore         float64 `json:"avg_score"`
	ContractPass     int     `json:"contract_pass"`
	ModelCount       int     `json:"model_count"`
	AvgCostKRW       float64 `json:"avg_cost_krw"`
	AvgLatencyMS     float64 `json:"avg_latency_ms"`
	CreatedBy        string  `json:"created_by"`
	CreatedAt        string  `json:"created_at"`
}

func nowRFC() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// ── experiments ──────────────────────────────────────────────────────────────

func (s *SQLStore) CreatePromptExperiment(ctx context.Context, e PromptExperiment) error {
	if e.Status == "" {
		e.Status = "active"
	}
	now := nowRFC()
	e.CreatedAt, e.UpdatedAt = now, now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_experiments
		(id, title, description, team, owner, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.Title, e.Description, e.Team, e.Owner, e.Status, e.CreatedAt, e.UpdatedAt)
	return err
}

func (s *SQLStore) ListPromptExperiments(ctx context.Context) ([]PromptExperiment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, description, team, owner, status, created_at, updated_at
		FROM prompt_experiments ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptExperiment{}
	for rows.Next() {
		var e PromptExperiment
		if err := rows.Scan(&e.ID, &e.Title, &e.Description, &e.Team, &e.Owner, &e.Status, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetPromptExperiment(ctx context.Context, id string) (PromptExperiment, bool, error) {
	var e PromptExperiment
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, title, description, team, owner, status, created_at, updated_at
		FROM prompt_experiments WHERE id = ?`), id).
		Scan(&e.ID, &e.Title, &e.Description, &e.Team, &e.Owner, &e.Status, &e.CreatedAt, &e.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptExperiment{}, false, nil
	}
	if err != nil {
		return PromptExperiment{}, false, err
	}
	return e, true, nil
}

func (s *SQLStore) UpdatePromptExperimentStatus(ctx context.Context, id, status string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE prompt_experiments SET status = ?, updated_at = ? WHERE id = ?`),
		status, nowRFC(), id)
	return err
}

func (s *SQLStore) DeletePromptExperiment(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM prompt_test_case_runs WHERE test_case_id IN (SELECT id FROM prompt_test_cases WHERE experiment_id = ?)`,
		`DELETE FROM prompt_test_cases WHERE experiment_id = ?`,
		`DELETE FROM prompt_experiments WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, s.bind(q), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ── rubrics ──────────────────────────────────────────────────────────────────

func (s *SQLStore) CreatePromptRubric(ctx context.Context, rb PromptRubric) error {
	rb.CreatedAt = nowRFC()
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_rubrics (id, name, criteria_json, created_by, created_at)
		VALUES (?, ?, ?, ?, ?)`), rb.ID, rb.Name, rb.CriteriaJSON, rb.CreatedBy, rb.CreatedAt)
	return err
}

func (s *SQLStore) ListPromptRubrics(ctx context.Context) ([]PromptRubric, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, criteria_json, created_by, created_at FROM prompt_rubrics ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptRubric{}
	for rows.Next() {
		var rb PromptRubric
		if err := rows.Scan(&rb.ID, &rb.Name, &rb.CriteriaJSON, &rb.CreatedBy, &rb.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rb)
	}
	return out, rows.Err()
}

// ── contracts ──────────────────────────────────────────────────────────────

func (s *SQLStore) CreatePromptContract(ctx context.Context, c PromptContract) error {
	c.CreatedAt = nowRFC()
	strict := 0
	if c.Strict {
		strict = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_contracts (id, name, type, schema_json, strict, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`), c.ID, c.Name, c.Type, c.SchemaJSON, strict, c.CreatedBy, c.CreatedAt)
	return err
}

func (s *SQLStore) ListPromptContracts(ctx context.Context) ([]PromptContract, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, type, schema_json, strict, created_by, created_at FROM prompt_contracts ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptContract{}
	for rows.Next() {
		var c PromptContract
		var strict int
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.SchemaJSON, &strict, &c.CreatedBy, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.Strict = strict != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetPromptContract(ctx context.Context, id string) (PromptContract, bool, error) {
	var c PromptContract
	var strict int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, type, schema_json, strict, created_by, created_at FROM prompt_contracts WHERE id = ?`), id).
		Scan(&c.ID, &c.Name, &c.Type, &c.SchemaJSON, &strict, &c.CreatedBy, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptContract{}, false, nil
	}
	if err != nil {
		return PromptContract{}, false, err
	}
	c.Strict = strict != 0
	return c, true, nil
}

// ── test cases ───────────────────────────────────────────────────────────────

func (s *SQLStore) CreatePromptTestCase(ctx context.Context, tc PromptTestCase) error {
	now := nowRFC()
	tc.CreatedAt, tc.UpdatedAt = now, now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_test_cases
		(id, experiment_id, name, messages_json, messages_hash, rubric_id, contract_id, models_json, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		tc.ID, tc.ExperimentID, tc.Name, tc.MessagesJSON, tc.MessagesHash, tc.RubricID, tc.ContractID, tc.ModelsJSON, tc.CreatedBy, tc.CreatedAt, tc.UpdatedAt)
	return err
}

func (s *SQLStore) ListPromptTestCases(ctx context.Context, experimentID string) ([]PromptTestCase, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, experiment_id, name, messages_json, messages_hash, rubric_id, contract_id, models_json, created_by, created_at, updated_at
		FROM prompt_test_cases WHERE experiment_id = ? ORDER BY created_at DESC`), experimentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTestCase{}
	for rows.Next() {
		var tc PromptTestCase
		if err := rows.Scan(&tc.ID, &tc.ExperimentID, &tc.Name, &tc.MessagesJSON, &tc.MessagesHash, &tc.RubricID, &tc.ContractID, &tc.ModelsJSON, &tc.CreatedBy, &tc.CreatedAt, &tc.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetPromptTestCase(ctx context.Context, id string) (PromptTestCase, bool, error) {
	var tc PromptTestCase
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, experiment_id, name, messages_json, messages_hash, rubric_id, contract_id, models_json, created_by, created_at, updated_at
		FROM prompt_test_cases WHERE id = ?`), id).
		Scan(&tc.ID, &tc.ExperimentID, &tc.Name, &tc.MessagesJSON, &tc.MessagesHash, &tc.RubricID, &tc.ContractID, &tc.ModelsJSON, &tc.CreatedBy, &tc.CreatedAt, &tc.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptTestCase{}, false, nil
	}
	if err != nil {
		return PromptTestCase{}, false, err
	}
	return tc, true, nil
}

func (s *SQLStore) DeletePromptTestCase(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM prompt_test_case_runs WHERE test_case_id = ?`), id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM prompt_test_cases WHERE id = ?`), id); err != nil {
		return err
	}
	return tx.Commit()
}

// ── test-case runs (regression history) ──────────────────────────────────────

func (s *SQLStore) InsertPromptTestCaseRun(ctx context.Context, run PromptTestCaseRun) error {
	run.CreatedAt = nowRFC()
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_test_case_runs
		(id, test_case_id, run_id, best_model, avg_score, contract_pass, model_count, avg_cost_krw, avg_latency_ms, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.TestCaseID, run.RunID, run.BestModel, run.AvgScore, run.ContractPass, run.ModelCount, run.AvgCostKRW, run.AvgLatencyMS, run.CreatedBy, run.CreatedAt)
	return err
}

// ListPromptTestCaseRuns returns a test case's execution history, newest first (for regression
// trend display).
func (s *SQLStore) ListPromptTestCaseRuns(ctx context.Context, testCaseID string, limit int) ([]PromptTestCaseRun, error) {
	if limit <= 0 {
		limit = 30
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, test_case_id, run_id, best_model, avg_score, contract_pass, model_count, avg_cost_krw, avg_latency_ms, created_by, created_at
		FROM prompt_test_case_runs WHERE test_case_id = ? ORDER BY created_at DESC LIMIT ?`), testCaseID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTestCaseRun{}
	for rows.Next() {
		var r PromptTestCaseRun
		if err := rows.Scan(&r.ID, &r.TestCaseID, &r.RunID, &r.BestModel, &r.AvgScore, &r.ContractPass, &r.ModelCount, &r.AvgCostKRW, &r.AvgLatencyMS, &r.CreatedBy, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
