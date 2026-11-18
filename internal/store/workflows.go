package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// WorkflowStep is one ordered step of a workflow chain. Type is chat | text2sql | mcp_tool |
// skill | condition | approval | transform. Legacy limit fields are metadata; graph
// mode accepts only limits that its executor enforces.
type WorkflowStep struct {
	ID            string             `json:"id,omitempty"`
	Condition     *WorkflowCondition `json:"condition,omitempty"`
	Name          string             `json:"name"`
	Type          string             `json:"type"`
	Ref           string             `json:"ref,omitempty"`
	TimeoutMS     int64              `json:"timeout_ms,omitempty"`
	MaxCostKRW    float64            `json:"max_cost_krw,omitempty"`
	MaxTokens     int64              `json:"max_tokens,omitempty"`
	AllowedTools  []string           `json:"allowed_tools,omitempty"`
	AllowedTables []string           `json:"allowed_tables,omitempty"`
	Note          string             `json:"note,omitempty"`
}

// Workflow is a named, ordered chain of steps that automates a business procedure.
type Workflow struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Steps        []WorkflowStep `json:"steps"`
	Flow         *WorkflowFlow  `json:"flow,omitempty"`
	AllowedTeams string         `json:"allowed_teams"`
	Enabled      bool           `json:"enabled"`
	CreatedBy    string         `json:"created_by"`
	CreatedAt    string         `json:"created_at"`
	UpdatedAt    string         `json:"updated_at"`
}

func (s *SQLStore) UpsertWorkflow(ctx context.Context, wf Workflow) error {
	if err := ValidateWorkflowGraph(wf); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if wf.CreatedAt == "" {
		wf.CreatedAt = now
	}
	enabled := 0
	if wf.Enabled {
		enabled = 1
	}
	steps, err := json.Marshal(wf.Steps)
	if err != nil {
		return err
	}
	flow, err := encodeWorkflowFlow(wf.Flow)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflows
		(id, name, description, steps, allowed_teams, enabled, created_by, created_at, updated_at, flow)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
			steps=excluded.steps, allowed_teams=excluded.allowed_teams, enabled=excluded.enabled,
			updated_at=excluded.updated_at, flow=excluded.flow
		WHERE workflows.flow = '' OR excluded.flow <> ''`),
		wf.ID, wf.Name, wf.Description, string(steps), wf.AllowedTeams, enabled, wf.CreatedBy, wf.CreatedAt, now, flow)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return ErrWorkflowGraphEditRequired
	}
	return nil
}

func scanWorkflow(sc interface{ Scan(...any) error }) (Workflow, error) {
	var wf Workflow
	var steps, flow string
	var enabled int
	if err := sc.Scan(&wf.ID, &wf.Name, &wf.Description, &steps, &wf.AllowedTeams, &enabled, &wf.CreatedBy, &wf.CreatedAt, &wf.UpdatedAt, &flow); err != nil {
		return Workflow{}, err
	}
	wf.Enabled = enabled != 0
	if steps != "" {
		_ = json.Unmarshal([]byte(steps), &wf.Steps)
	}
	if err := decodeWorkflowFlow(flow, &wf.Flow); err != nil {
		return Workflow{}, err
	}
	return wf, nil
}

const workflowColumns = `id, name, description, steps, allowed_teams, enabled, created_by, created_at, updated_at, flow`

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
	Flow         *WorkflowFlow  `json:"flow,omitempty"`
	AllowedTeams string         `json:"allowed_teams"`
	PublishedBy  string         `json:"published_by"`
	PublishedAt  string         `json:"published_at"`
	Note         string         `json:"note"`
}

// PublishWorkflowVersion snapshots the workflow's current definition as the next version and
// enables it. Returns the new version number.
func (s *SQLStore) PublishWorkflowVersion(ctx context.Context, wf Workflow, publishedBy, note string) (int, error) {
	revision, err := WorkflowRevision(wf)
	if err != nil {
		return 0, err
	}
	return s.PublishWorkflowVersionReviewed(ctx, wf, revision, publishedBy, note, AdminAuditLog{ID: "aal_" + rand.Text(), AdminID: publishedBy, Action: "workflow.publish"})
}

// ListWorkflowVersions returns a workflow's version history, newest first.
func (s *SQLStore) ListWorkflowVersions(ctx context.Context, workflowID string) ([]WorkflowVersion, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, workflow_id, version, name, description, steps, allowed_teams, published_by, published_at, note, flow
		FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`), workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowVersion{}
	for rows.Next() {
		var v WorkflowVersion
		var steps, flow string
		if err := rows.Scan(&v.ID, &v.WorkflowID, &v.Version, &v.Name, &v.Description, &steps, &v.AllowedTeams, &v.PublishedBy, &v.PublishedAt, &v.Note, &flow); err != nil {
			return nil, err
		}
		if steps != "" {
			_ = json.Unmarshal([]byte(steps), &v.Steps)
		}
		if err := decodeWorkflowFlow(flow, &v.Flow); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// WorkflowRun is one execution (or planned execution) of a workflow — safe metadata only.
type WorkflowRun struct {
	ID         string `json:"id"`
	WorkflowID string `json:"workflow_id"`
	// Current definition name for bounded personal history; never raw steps.
	WorkflowName string  `json:"workflow_name,omitempty"`
	UserID       string  `json:"user_id"`
	Team         string  `json:"team"`
	Status       string  `json:"status"` // planned | ok | error
	StepsTotal   int     `json:"steps_total"`
	StepsOK      int     `json:"steps_ok"`
	LatencyMS    int64   `json:"latency_ms"`
	CostKRW      float64 `json:"cost_krw"`
	ErrorClass   string  `json:"error_class"`
	TraceID      string  `json:"trace_id"`
	CreatedAt    string  `json:"created_at"`
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
	StepID          string `json:"step_id,omitempty"`
	DefinitionIndex *int   `json:"definition_index,omitempty"`
	Branch          string `json:"branch,omitempty"`
	ID              string `json:"id"`
	RunID           string `json:"run_id"`
	StepIndex       int    `json:"step_index"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Ref             string `json:"ref"`
	Status          string `json:"status"` // ok | error | pending_approval | stopped | passed | skipped
	OutputChars     int    `json:"output_chars"`
	ErrorClass      string `json:"error_class"`
	CreatedAt       string `json:"created_at"`
}

// RecordWorkflowStepRuns persists per-step outcomes for a run (best-effort batch insert).
func (s *SQLStore) RecordWorkflowStepRuns(ctx context.Context, runID string, steps []WorkflowStepRun) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, st := range steps {
		definitionIndex := -1
		if st.DefinitionIndex != nil {
			definitionIndex = *st.DefinitionIndex
		}
		if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO workflow_step_runs
			(id, run_id, step_index, name, type, ref, status, output_chars, error_class, created_at, step_id, definition_index, branch)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			runID+"_"+itoaStore(st.StepIndex), runID, st.StepIndex, st.Name, st.Type, st.Ref, st.Status, st.OutputChars, st.ErrorClass, now, st.StepID, definitionIndex, st.Branch); err != nil {
			return err
		}
	}
	return nil
}

// ListWorkflowStepRuns returns a run's per-step outcomes in step order.
func (s *SQLStore) ListWorkflowStepRuns(ctx context.Context, runID string) ([]WorkflowStepRun, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, step_index, name, type, ref, status, output_chars, error_class, created_at, step_id, definition_index, branch
		FROM workflow_step_runs WHERE run_id = ? ORDER BY step_index ASC`), runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowStepRun{}
	for rows.Next() {
		var st WorkflowStepRun
		var definitionIndex int
		if err := rows.Scan(&st.ID, &st.RunID, &st.StepIndex, &st.Name, &st.Type, &st.Ref, &st.Status, &st.OutputChars, &st.ErrorClass, &st.CreatedAt, &st.StepID, &definitionIndex, &st.Branch); err != nil {
			return nil, err
		}
		if definitionIndex >= 0 {
			st.DefinitionIndex = &definitionIndex
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *SQLStore) ListWorkflowRuns(ctx context.Context, userID, workflowID string, limit int) ([]WorkflowRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT r.id, r.workflow_id, r.user_id, r.team, r.status, r.steps_total, r.steps_ok, r.latency_ms, r.cost_krw, r.error_class, r.trace_id, r.created_at, COALESCE(w.name, '')
		FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE r.user_id = ?`
	args := []any{userID}
	if workflowID != "" {
		q += ` AND r.workflow_id = ?`
		args = append(args, workflowID)
	}
	q += ` ORDER BY r.created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkflowRun{}
	for rows.Next() {
		var run WorkflowRun
		if err := rows.Scan(&run.ID, &run.WorkflowID, &run.UserID, &run.Team, &run.Status, &run.StepsTotal, &run.StepsOK, &run.LatencyMS, &run.CostKRW, &run.ErrorClass, &run.TraceID, &run.CreatedAt, &run.WorkflowName); err != nil {
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
