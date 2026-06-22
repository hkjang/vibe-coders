package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// WorkflowStep is one ordered step of a workflow chain. Type is chat | text2sql | mcp_tool |
// skill | condition | approval | transform. Per-step safety limits bound cost/tokens/time and
// the tools/tables a step may touch.
type WorkflowStep struct {
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	Ref           string   `json:"ref,omitempty"`
	TimeoutMS     int64    `json:"timeout_ms,omitempty"`
	MaxCostKRW    float64  `json:"max_cost_krw,omitempty"`
	MaxTokens     int64    `json:"max_tokens,omitempty"`
	AllowedTools  []string `json:"allowed_tools,omitempty"`
	AllowedTables []string `json:"allowed_tables,omitempty"`
	Note          string   `json:"note,omitempty"`
}

// Workflow is a named, ordered chain of steps that automates a business procedure.
type Workflow struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Steps        []WorkflowStep `json:"steps"`
	AllowedTeams string         `json:"allowed_teams"`
	Enabled      bool           `json:"enabled"`
	CreatedBy    string         `json:"created_by"`
	CreatedAt    string         `json:"created_at"`
	UpdatedAt    string         `json:"updated_at"`
}

func (s *SQLStore) UpsertWorkflow(ctx context.Context, wf Workflow) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if wf.CreatedAt == "" {
		wf.CreatedAt = now
	}
	enabled := 0
	if wf.Enabled {
		enabled = 1
	}
	steps, _ := json.Marshal(wf.Steps)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflows
		(id, name, description, steps, allowed_teams, enabled, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
			steps=excluded.steps, allowed_teams=excluded.allowed_teams, enabled=excluded.enabled,
			updated_at=excluded.updated_at`),
		wf.ID, wf.Name, wf.Description, string(steps), wf.AllowedTeams, enabled, wf.CreatedBy, wf.CreatedAt, now)
	return err
}

func scanWorkflow(sc interface{ Scan(...any) error }) (Workflow, error) {
	var wf Workflow
	var steps string
	var enabled int
	if err := sc.Scan(&wf.ID, &wf.Name, &wf.Description, &steps, &wf.AllowedTeams, &enabled, &wf.CreatedBy, &wf.CreatedAt, &wf.UpdatedAt); err != nil {
		return Workflow{}, err
	}
	wf.Enabled = enabled != 0
	if steps != "" {
		_ = json.Unmarshal([]byte(steps), &wf.Steps)
	}
	return wf, nil
}

const workflowColumns = `id, name, description, steps, allowed_teams, enabled, created_by, created_at, updated_at`

func (s *SQLStore) ListWorkflows(ctx context.Context) ([]Workflow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+workflowColumns+` FROM workflows ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Workflow{}
	for rows.Next() {
		wf, err := scanWorkflow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, wf)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetWorkflow(ctx context.Context, id string) (Workflow, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT `+workflowColumns+` FROM workflows WHERE id = ?`), id)
	wf, err := scanWorkflow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Workflow{}, false, nil
	}
	if err != nil {
		return Workflow{}, false, err
	}
	return wf, true, nil
}

func (s *SQLStore) DeleteWorkflow(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM workflows WHERE id = ?`), id)
	return err
}

// WorkflowVersion is an immutable snapshot of a workflow definition captured at publish time.
type WorkflowVersion struct {
	ID           string         `json:"id"`
	WorkflowID   string         `json:"workflow_id"`
	Version      int            `json:"version"`
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Steps        []WorkflowStep `json:"steps"`
	AllowedTeams string         `json:"allowed_teams"`
	PublishedBy  string         `json:"published_by"`
	PublishedAt  string         `json:"published_at"`
	Note         string         `json:"note"`
}

// PublishWorkflowVersion snapshots the workflow's current definition as the next version and
// enables it. Returns the new version number.
func (s *SQLStore) PublishWorkflowVersion(ctx context.Context, wf Workflow, publishedBy, note string) (int, error) {
	var maxVer int
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(MAX(version), 0) FROM workflow_versions WHERE workflow_id = ?`), wf.ID)
	if err := row.Scan(&maxVer); err != nil {
		return 0, err
	}
	version := maxVer + 1
	steps, _ := json.Marshal(wf.Steps)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflow_versions
		(id, workflow_id, version, name, description, steps, allowed_teams, published_by, published_at, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		"wfver_"+wf.ID+"_"+itoaStore(version), wf.ID, version, wf.Name, wf.Description, string(steps),
		wf.AllowedTeams, publishedBy, now, note); err != nil {
		return 0, err
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE workflows SET enabled = 1, updated_at = ? WHERE id = ?`), now, wf.ID); err != nil {
		return 0, err
	}
	return version, nil
}

// ListWorkflowVersions returns a workflow's version history, newest first.
func (s *SQLStore) ListWorkflowVersions(ctx context.Context, workflowID string) ([]WorkflowVersion, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, workflow_id, version, name, description, steps, allowed_teams, published_by, published_at, note
		FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`), workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowVersion{}
	for rows.Next() {
		var v WorkflowVersion
		var steps string
		if err := rows.Scan(&v.ID, &v.WorkflowID, &v.Version, &v.Name, &v.Description, &steps, &v.AllowedTeams, &v.PublishedBy, &v.PublishedAt, &v.Note); err != nil {
			return nil, err
		}
		if steps != "" {
			_ = json.Unmarshal([]byte(steps), &v.Steps)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// WorkflowRun is one execution (or planned execution) of a workflow — safe metadata only.
type WorkflowRun struct {
	ID         string  `json:"id"`
	WorkflowID string  `json:"workflow_id"`
	UserID     string  `json:"user_id"`
	Team       string  `json:"team"`
	Status     string  `json:"status"` // planned | ok | error
	StepsTotal int     `json:"steps_total"`
	StepsOK    int     `json:"steps_ok"`
	LatencyMS  int64   `json:"latency_ms"`
	CostKRW    float64 `json:"cost_krw"`
	ErrorClass string  `json:"error_class"`
	TraceID    string  `json:"trace_id"`
	CreatedAt  string  `json:"created_at"`
}

func (s *SQLStore) RecordWorkflowRun(ctx context.Context, run WorkflowRun) error {
	if run.CreatedAt == "" {
		run.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if run.Status == "" {
		run.Status = "planned"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflow_runs
		(id, workflow_id, user_id, team, status, steps_total, steps_ok, latency_ms, cost_krw, error_class, trace_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.WorkflowID, run.UserID, run.Team, run.Status, run.StepsTotal, run.StepsOK, run.LatencyMS, run.CostKRW, run.ErrorClass, run.TraceID, run.CreatedAt)
	return err
}

// GetWorkflowRun returns one workflow run by id.
func (s *SQLStore) GetWorkflowRun(ctx context.Context, id string) (WorkflowRun, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, workflow_id, user_id, team, status, steps_total, steps_ok, latency_ms, cost_krw, error_class, trace_id, created_at
		FROM workflow_runs WHERE id = ?`), id)
	var run WorkflowRun
	err := row.Scan(&run.ID, &run.WorkflowID, &run.UserID, &run.Team, &run.Status, &run.StepsTotal, &run.StepsOK, &run.LatencyMS, &run.CostKRW, &run.ErrorClass, &run.TraceID, &run.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkflowRun{}, false, nil
	}
	if err != nil {
		return WorkflowRun{}, false, err
	}
	return run, true, nil
}

// WorkflowStepRun is one step's outcome within a run — safe metadata only (no raw output/SQL/args).
type WorkflowStepRun struct {
	ID          string `json:"id"`
	RunID       string `json:"run_id"`
	StepIndex   int    `json:"step_index"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Ref         string `json:"ref"`
	Status      string `json:"status"` // ok | error | pending_approval | stopped | passed | skipped
	OutputChars int    `json:"output_chars"`
	ErrorClass  string `json:"error_class"`
	CreatedAt   string `json:"created_at"`
}

// RecordWorkflowStepRuns persists per-step outcomes for a run (best-effort batch insert).
func (s *SQLStore) RecordWorkflowStepRuns(ctx context.Context, runID string, steps []WorkflowStepRun) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, st := range steps {
		if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflow_step_runs
			(id, run_id, step_index, name, type, ref, status, output_chars, error_class, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			runID+"_"+itoaStore(st.StepIndex), runID, st.StepIndex, st.Name, st.Type, st.Ref, st.Status, st.OutputChars, st.ErrorClass, now); err != nil {
			return err
		}
	}
	return nil
}

// ListWorkflowStepRuns returns a run's per-step outcomes in step order.
func (s *SQLStore) ListWorkflowStepRuns(ctx context.Context, runID string) ([]WorkflowStepRun, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, step_index, name, type, ref, status, output_chars, error_class, created_at
		FROM workflow_step_runs WHERE run_id = ? ORDER BY step_index ASC`), runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowStepRun{}
	for rows.Next() {
		var st WorkflowStepRun
		if err := rows.Scan(&st.ID, &st.RunID, &st.StepIndex, &st.Name, &st.Type, &st.Ref, &st.Status, &st.OutputChars, &st.ErrorClass, &st.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *SQLStore) ListWorkflowRuns(ctx context.Context, userID, workflowID string, limit int) ([]WorkflowRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT id, workflow_id, user_id, team, status, steps_total, steps_ok, latency_ms, cost_krw, error_class, trace_id, created_at
		FROM workflow_runs WHERE user_id = ?`
	args := []any{userID}
	if workflowID != "" {
		q += ` AND workflow_id = ?`
		args = append(args, workflowID)
	}
	q += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowRun{}
	for rows.Next() {
		var run WorkflowRun
		if err := rows.Scan(&run.ID, &run.WorkflowID, &run.UserID, &run.Team, &run.Status, &run.StepsTotal, &run.StepsOK, &run.LatencyMS, &run.CostKRW, &run.ErrorClass, &run.TraceID, &run.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// WorkflowRunsByTrace returns workflow runs that belong to a trace (newest first).
func (s *SQLStore) WorkflowRunsByTrace(ctx context.Context, traceID string) ([]WorkflowRun, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, workflow_id, user_id, team, status, steps_total, steps_ok, latency_ms, cost_krw, error_class, trace_id, created_at
		FROM workflow_runs WHERE trace_id = ? ORDER BY created_at DESC`), traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowRun{}
	for rows.Next() {
		var run WorkflowRun
		if err := rows.Scan(&run.ID, &run.WorkflowID, &run.UserID, &run.Team, &run.Status, &run.StepsTotal, &run.StepsOK, &run.LatencyMS, &run.CostKRW, &run.ErrorClass, &run.TraceID, &run.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}
