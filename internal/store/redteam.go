package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// RedTeamTarget is a registered, allowed target collected from existing gateway registries.
// It mirrors providers, MCP upstreams/tools, Text2SQL virtual models, AI apps, and workflows.
type RedTeamTarget struct {
	ID          string         `json:"id"`
	TargetType  string         `json:"target_type"`
	TargetRef   string         `json:"target_ref"`
	Provider    string         `json:"provider"`
	Model       string         `json:"model"`
	MCPUpstream string         `json:"mcp_upstream"`
	ToolName    string         `json:"tool_name"`
	OwnerTeam   string         `json:"owner_team"`
	RiskLevel   string         `json:"risk_level"`
	Enabled     bool           `json:"enabled"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

type RedTeamTargetFilter struct {
	TargetType  string
	Provider    string
	OwnerTeam   string
	RiskLevel   string
	EnabledOnly bool
	Limit       int
}

type RedTeamProbePack struct {
	ID               string             `json:"id"`
	Name             string             `json:"name"`
	Category         string             `json:"category"`
	Severity         string             `json:"severity"`
	Version          string             `json:"version"`
	Enabled          bool               `json:"enabled"`
	RequiresApproval bool               `json:"requires_approval"`
	CreatedBy        string             `json:"created_by"`
	CreatedAt        string             `json:"created_at"`
	UpdatedAt        string             `json:"updated_at"`
	Cases            []RedTeamProbeCase `json:"cases,omitempty"`
}

type RedTeamProbeCase struct {
	ID             string         `json:"id"`
	PackID         string         `json:"pack_id"`
	CaseKey        string         `json:"case_key"`
	InputTemplate  string         `json:"input_template"`
	ExpectedPolicy string         `json:"expected_policy"`
	EvaluatorType  string         `json:"evaluator_type"`
	Severity       string         `json:"severity"`
	RiskTags       []string       `json:"risk_tags"`
	TargetTypes    []string       `json:"target_types"`
	Parameters     map[string]any `json:"parameters"`
	CreatedAt      string         `json:"created_at"`
	UpdatedAt      string         `json:"updated_at"`
}

type RedTeamCampaign struct {
	ID                      string         `json:"id"`
	Name                    string         `json:"name"`
	Scope                   string         `json:"scope"`
	Status                  string         `json:"status"`
	ExecutionMode           string         `json:"execution_mode"`
	CreatedBy               string         `json:"created_by"`
	ApprovedBy              string         `json:"approved_by"`
	Schedule                string         `json:"schedule"`
	BudgetLimitKRW          float64        `json:"budget_limit_krw"`
	QPSLimit                float64        `json:"qps_limit"`
	TimeoutMS               int            `json:"timeout_ms"`
	Concurrency             int            `json:"concurrency"`
	TargetFilter            map[string]any `json:"target_filter"`
	ProbePackIDs            []string       `json:"probe_pack_ids"`
	EvidenceRetentionDays   int            `json:"evidence_retention_days"`
	ExternalProviderAllowed bool           `json:"external_provider_allowed"`
	DestructiveToolPolicy   string         `json:"destructive_tool_policy"`
	CreatedAt               string         `json:"created_at"`
	UpdatedAt               string         `json:"updated_at"`
}

type RedTeamRun struct {
	ID          string  `json:"id"`
	CampaignID  string  `json:"campaign_id"`
	TargetID    string  `json:"target_id"`
	StartedAt   string  `json:"started_at"`
	EndedAt     string  `json:"ended_at"`
	Status      string  `json:"status"`
	TotalCases  int     `json:"total_cases"`
	FailedCases int     `json:"failed_cases"`
	RiskScore   int     `json:"risk_score"`
	CostKRW     float64 `json:"cost_krw"`
	Mode        string  `json:"mode"`
	CreatedAt   string  `json:"created_at"`
}

type RedTeamCaseResult struct {
	ID             string  `json:"id"`
	RunID          string  `json:"run_id"`
	CaseID         string  `json:"case_id"`
	RequestID      string  `json:"request_id"`
	Decision       string  `json:"decision"`
	Severity       string  `json:"severity"`
	EvidenceHash   string  `json:"evidence_hash"`
	PolicyDecision string  `json:"policy_decision"`
	LatencyMS      int64   `json:"latency_ms"`
	CostKRW        float64 `json:"cost_krw"`
	CreatedAt      string  `json:"created_at"`
}

type RedTeamEvidence struct {
	ID             string           `json:"id"`
	ResultID       string           `json:"result_id"`
	MaskedPrompt   string           `json:"masked_prompt"`
	MaskedResponse string           `json:"masked_response"`
	ToolCalls      []map[string]any `json:"tool_calls"`
	HeadersSummary map[string]any   `json:"headers_summary"`
	ExportHash     string           `json:"export_hash"`
	CreatedAt      string           `json:"created_at"`
}

type RedTeamRemediation struct {
	ID            string         `json:"id"`
	ResultID      string         `json:"result_id"`
	ActionType    string         `json:"action_type"`
	ActionPayload map[string]any `json:"action_payload"`
	Status        string         `json:"status"`
	Owner         string         `json:"owner"`
	DueDate       string         `json:"due_date"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
}

type RedTeamBaseline struct {
	ID             string `json:"id"`
	TargetID       string `json:"target_id"`
	PackID         string `json:"pack_id"`
	BaselineScore  int    `json:"baseline_score"`
	LastPassedAt   string `json:"last_passed_at"`
	DriftThreshold int    `json:"drift_threshold"`
	UpdatedAt      string `json:"updated_at"`
}

type RedTeamSchedule struct {
	ID                 string `json:"id"`
	CampaignTemplateID string `json:"campaign_template_id"`
	CronExpr           string `json:"cron_expr"`
	Timezone           string `json:"timezone"`
	Enabled            bool   `json:"enabled"`
	LastRunAt          string `json:"last_run_at"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

func (s *SQLStore) SyncRedTeamTargets(ctx context.Context, targets []RedTeamTarget) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`UPDATE redteam_targets SET enabled = 0, updated_at = ?`), now); err != nil {
		return err
	}
	for _, t := range targets {
		if t.ID == "" || t.TargetType == "" || t.TargetRef == "" {
			continue
		}
		if t.RiskLevel == "" {
			t.RiskLevel = "low"
		}
		if t.CreatedAt == "" {
			t.CreatedAt = now
		}
		t.UpdatedAt = now
		meta, _ := json.Marshal(nonNilMap(t.Metadata))
		_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO redteam_targets
			(id, target_type, target_ref, provider, model, mcp_upstream, tool_name, owner_team, risk_level, enabled, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				target_type=excluded.target_type, target_ref=excluded.target_ref, provider=excluded.provider,
				model=excluded.model, mcp_upstream=excluded.mcp_upstream, tool_name=excluded.tool_name,
				owner_team=excluded.owner_team, risk_level=excluded.risk_level, enabled=excluded.enabled,
				metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`),
			t.ID, t.TargetType, t.TargetRef, t.Provider, t.Model, t.MCPUpstream, t.ToolName, t.OwnerTeam,
			t.RiskLevel, boolInt(t.Enabled), string(meta), t.CreatedAt, t.UpdatedAt)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLStore) ListRedTeamTargets(ctx context.Context, f RedTeamTargetFilter) ([]RedTeamTarget, error) {
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	where := []string{"1=1"}
	args := []any{}
	add := func(col, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		where = append(where, col+" = ?")
		args = append(args, value)
	}
	add("target_type", f.TargetType)
	add("provider", f.Provider)
	add("owner_team", f.OwnerTeam)
	add("risk_level", f.RiskLevel)
	if f.EnabledOnly {
		where = append(where, "enabled = 1")
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, target_type, target_ref, provider, model, mcp_upstream, tool_name,
		owner_team, risk_level, enabled, metadata_json, created_at, updated_at
		FROM redteam_targets WHERE `+strings.Join(where, " AND ")+`
		ORDER BY enabled DESC, target_type ASC, risk_level DESC, target_ref ASC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamTarget{}
	for rows.Next() {
		t, err := scanRedTeamTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetRedTeamTarget(ctx context.Context, id string) (RedTeamTarget, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, target_type, target_ref, provider, model, mcp_upstream, tool_name,
		owner_team, risk_level, enabled, metadata_json, created_at, updated_at FROM redteam_targets WHERE id = ?`), id)
	t, err := scanRedTeamTarget(row)
	if errors.Is(err, sql.ErrNoRows) {
		return RedTeamTarget{}, false, nil
	}
	if err != nil {
		return RedTeamTarget{}, false, err
	}
	return t, true, nil
}

func scanRedTeamTarget(sc interface{ Scan(...any) error }) (RedTeamTarget, error) {
	var t RedTeamTarget
	var enabled int
	var meta string
	if err := sc.Scan(&t.ID, &t.TargetType, &t.TargetRef, &t.Provider, &t.Model, &t.MCPUpstream, &t.ToolName,
		&t.OwnerTeam, &t.RiskLevel, &enabled, &meta, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return RedTeamTarget{}, err
	}
	t.Enabled = enabled != 0
	t.Metadata = decodeJSONMap(meta)
	return t, nil
}

func (s *SQLStore) UpsertRedTeamProbePackWithCases(ctx context.Context, pack RedTeamProbePack, cases []RedTeamProbeCase) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if pack.CreatedAt == "" {
		pack.CreatedAt = now
	}
	if pack.UpdatedAt == "" {
		pack.UpdatedAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO redteam_probe_packs
		(id, name, category, severity, version, enabled, requires_approval, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, severity=excluded.severity,
			version=excluded.version, enabled=excluded.enabled, requires_approval=excluded.requires_approval,
			updated_at=excluded.updated_at`),
		pack.ID, pack.Name, pack.Category, pack.Severity, pack.Version, boolInt(pack.Enabled),
		boolInt(pack.RequiresApproval), pack.CreatedBy, pack.CreatedAt, pack.UpdatedAt); err != nil {
		return err
	}
	if cases != nil {
		if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM redteam_probe_cases WHERE pack_id = ?`), pack.ID); err != nil {
			return err
		}
		for _, c := range cases {
			if c.ID == "" {
				continue
			}
			if c.PackID == "" {
				c.PackID = pack.ID
			}
			if c.CreatedAt == "" {
				c.CreatedAt = now
			}
			c.UpdatedAt = now
			params, _ := json.Marshal(nonNilMap(c.Parameters))
			if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO redteam_probe_cases
				(id, pack_id, case_key, input_template, expected_policy, evaluator_type, severity, risk_tags, target_types, parameters_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
				c.ID, c.PackID, c.CaseKey, c.InputTemplate, c.ExpectedPolicy, c.EvaluatorType, c.Severity,
				encodeStringList(c.RiskTags), encodeStringList(c.TargetTypes), string(params), c.CreatedAt, c.UpdatedAt); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (s *SQLStore) ListRedTeamProbePacks(ctx context.Context, includeCases bool) ([]RedTeamProbePack, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, category, severity, version, enabled, requires_approval, created_by, created_at, updated_at
		FROM redteam_probe_packs ORDER BY category ASC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamProbePack{}
	for rows.Next() {
		p, err := scanRedTeamProbePack(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if includeCases {
		for i := range out {
			cases, err := s.RedTeamProbeCases(ctx, []string{out[i].ID})
			if err != nil {
				return nil, err
			}
			out[i].Cases = cases
		}
	}
	return out, nil
}

func (s *SQLStore) RedTeamProbeCases(ctx context.Context, packIDs []string) ([]RedTeamProbeCase, error) {
	if len(packIDs) == 0 {
		return []RedTeamProbeCase{}, nil
	}
	where := "pack_id IN (" + placeholders(len(packIDs)) + ")"
	args := make([]any, 0, len(packIDs))
	for _, id := range packIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, pack_id, case_key, input_template, expected_policy, evaluator_type,
		severity, risk_tags, target_types, parameters_json, created_at, updated_at
		FROM redteam_probe_cases WHERE `+where+` ORDER BY pack_id ASC, case_key ASC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamProbeCase{}
	for rows.Next() {
		c, err := scanRedTeamProbeCase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func scanRedTeamProbePack(sc interface{ Scan(...any) error }) (RedTeamProbePack, error) {
	var p RedTeamProbePack
	var enabled, approval int
	if err := sc.Scan(&p.ID, &p.Name, &p.Category, &p.Severity, &p.Version, &enabled, &approval, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return RedTeamProbePack{}, err
	}
	p.Enabled = enabled != 0
	p.RequiresApproval = approval != 0
	return p, nil
}

func scanRedTeamProbeCase(sc interface{ Scan(...any) error }) (RedTeamProbeCase, error) {
	var c RedTeamProbeCase
	var tags, targets, params string
	if err := sc.Scan(&c.ID, &c.PackID, &c.CaseKey, &c.InputTemplate, &c.ExpectedPolicy, &c.EvaluatorType,
		&c.Severity, &tags, &targets, &params, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return RedTeamProbeCase{}, err
	}
	c.RiskTags = decodeStringList(tags)
	c.TargetTypes = decodeStringList(targets)
	c.Parameters = decodeJSONMap(params)
	return c, nil
}

func (s *SQLStore) UpsertRedTeamCampaign(ctx context.Context, c RedTeamCampaign) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if c.CreatedAt == "" {
		c.CreatedAt = now
	}
	if c.UpdatedAt == "" {
		c.UpdatedAt = now
	}
	filter, _ := json.Marshal(nonNilMap(c.TargetFilter))
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_campaigns
		(id, name, scope, status, execution_mode, created_by, approved_by, schedule, budget_limit_krw, qps_limit, timeout_ms, concurrency,
		 target_filter_json, probe_pack_ids_json, evidence_retention_days, external_provider_allowed, destructive_tool_policy, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, scope=excluded.scope, status=excluded.status,
			execution_mode=excluded.execution_mode, approved_by=excluded.approved_by, schedule=excluded.schedule,
			budget_limit_krw=excluded.budget_limit_krw, qps_limit=excluded.qps_limit, timeout_ms=excluded.timeout_ms,
			concurrency=excluded.concurrency, target_filter_json=excluded.target_filter_json,
			probe_pack_ids_json=excluded.probe_pack_ids_json, evidence_retention_days=excluded.evidence_retention_days,
			external_provider_allowed=excluded.external_provider_allowed, destructive_tool_policy=excluded.destructive_tool_policy,
			updated_at=excluded.updated_at`),
		c.ID, c.Name, c.Scope, c.Status, c.ExecutionMode, c.CreatedBy, c.ApprovedBy, c.Schedule, c.BudgetLimitKRW,
		c.QPSLimit, c.TimeoutMS, c.Concurrency, string(filter), encodeStringList(c.ProbePackIDs),
		c.EvidenceRetentionDays, boolInt(c.ExternalProviderAllowed), c.DestructiveToolPolicy, c.CreatedAt, c.UpdatedAt)
	return err
}

func (s *SQLStore) UpdateRedTeamCampaignStatus(ctx context.Context, id, status, approvedBy string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE redteam_campaigns SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?`),
		status, approvedBy, time.Now().UTC().Format(time.RFC3339Nano), id)
	return err
}

func (s *SQLStore) ListRedTeamCampaigns(ctx context.Context, limit int) ([]RedTeamCampaign, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, name, scope, status, execution_mode, created_by, approved_by, schedule,
		budget_limit_krw, qps_limit, timeout_ms, concurrency, target_filter_json, probe_pack_ids_json, evidence_retention_days,
		external_provider_allowed, destructive_tool_policy, created_at, updated_at
		FROM redteam_campaigns ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamCampaign{}
	for rows.Next() {
		c, err := scanRedTeamCampaign(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetRedTeamCampaign(ctx context.Context, id string) (RedTeamCampaign, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, scope, status, execution_mode, created_by, approved_by, schedule,
		budget_limit_krw, qps_limit, timeout_ms, concurrency, target_filter_json, probe_pack_ids_json, evidence_retention_days,
		external_provider_allowed, destructive_tool_policy, created_at, updated_at
		FROM redteam_campaigns WHERE id = ?`), id)
	c, err := scanRedTeamCampaign(row)
	if errors.Is(err, sql.ErrNoRows) {
		return RedTeamCampaign{}, false, nil
	}
	if err != nil {
		return RedTeamCampaign{}, false, err
	}
	return c, true, nil
}

func scanRedTeamCampaign(sc interface{ Scan(...any) error }) (RedTeamCampaign, error) {
	var c RedTeamCampaign
	var filter, packs string
	var external int
	if err := sc.Scan(&c.ID, &c.Name, &c.Scope, &c.Status, &c.ExecutionMode, &c.CreatedBy, &c.ApprovedBy, &c.Schedule,
		&c.BudgetLimitKRW, &c.QPSLimit, &c.TimeoutMS, &c.Concurrency, &filter, &packs, &c.EvidenceRetentionDays,
		&external, &c.DestructiveToolPolicy, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return RedTeamCampaign{}, err
	}
	c.TargetFilter = decodeJSONMap(filter)
	c.ProbePackIDs = decodeStringList(packs)
	c.ExternalProviderAllowed = external != 0
	return c, nil
}

func (s *SQLStore) InsertRedTeamRun(ctx context.Context, r RedTeamRun) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if r.StartedAt == "" {
		r.StartedAt = now
	}
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_runs
		(id, campaign_id, target_id, started_at, ended_at, status, total_cases, failed_cases, risk_score, cost_krw, mode, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		r.ID, r.CampaignID, r.TargetID, r.StartedAt, r.EndedAt, r.Status, r.TotalCases, r.FailedCases, r.RiskScore, r.CostKRW, r.Mode, r.CreatedAt)
	return err
}

func (s *SQLStore) UpdateRedTeamRun(ctx context.Context, r RedTeamRun) error {
	if r.EndedAt == "" {
		r.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE redteam_runs SET ended_at = ?, status = ?, total_cases = ?, failed_cases = ?, risk_score = ?, cost_krw = ? WHERE id = ?`),
		r.EndedAt, r.Status, r.TotalCases, r.FailedCases, r.RiskScore, r.CostKRW, r.ID)
	return err
}

func (s *SQLStore) ListRedTeamRuns(ctx context.Context, limit int) ([]RedTeamRun, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, campaign_id, target_id, started_at, ended_at, status, total_cases, failed_cases, risk_score, cost_krw, mode, created_at
		FROM redteam_runs ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamRun{}
	for rows.Next() {
		r, err := scanRedTeamRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetRedTeamRun(ctx context.Context, id string) (RedTeamRun, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, campaign_id, target_id, started_at, ended_at, status, total_cases, failed_cases, risk_score, cost_krw, mode, created_at
		FROM redteam_runs WHERE id = ?`), id)
	r, err := scanRedTeamRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return RedTeamRun{}, false, nil
	}
	if err != nil {
		return RedTeamRun{}, false, err
	}
	return r, true, nil
}

func scanRedTeamRun(sc interface{ Scan(...any) error }) (RedTeamRun, error) {
	var r RedTeamRun
	if err := sc.Scan(&r.ID, &r.CampaignID, &r.TargetID, &r.StartedAt, &r.EndedAt, &r.Status, &r.TotalCases, &r.FailedCases, &r.RiskScore, &r.CostKRW, &r.Mode, &r.CreatedAt); err != nil {
		return RedTeamRun{}, err
	}
	return r, nil
}

func (s *SQLStore) InsertRedTeamCaseResult(ctx context.Context, r RedTeamCaseResult) error {
	if r.CreatedAt == "" {
		r.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_case_results
		(id, run_id, case_id, request_id, decision, severity, evidence_hash, policy_decision, latency_ms, cost_krw, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		r.ID, r.RunID, r.CaseID, r.RequestID, r.Decision, r.Severity, r.EvidenceHash, r.PolicyDecision, r.LatencyMS, r.CostKRW, r.CreatedAt)
	return err
}

func (s *SQLStore) ListRedTeamCaseResults(ctx context.Context, runID string) ([]RedTeamCaseResult, error) {
	where := "1=1"
	args := []any{}
	if strings.TrimSpace(runID) != "" {
		where = "run_id = ?"
		args = append(args, runID)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, run_id, case_id, request_id, decision, severity, evidence_hash, policy_decision, latency_ms, cost_krw, created_at
		FROM redteam_case_results WHERE `+where+` ORDER BY created_at ASC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamCaseResult{}
	for rows.Next() {
		var r RedTeamCaseResult
		if err := rows.Scan(&r.ID, &r.RunID, &r.CaseID, &r.RequestID, &r.Decision, &r.Severity, &r.EvidenceHash, &r.PolicyDecision, &r.LatencyMS, &r.CostKRW, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *SQLStore) InsertRedTeamEvidence(ctx context.Context, e RedTeamEvidence) error {
	if e.CreatedAt == "" {
		e.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	tools, _ := json.Marshal(e.ToolCalls)
	headers, _ := json.Marshal(nonNilMap(e.HeadersSummary))
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_evidence
		(id, result_id, masked_prompt, masked_response, tool_calls_json, headers_summary_json, export_hash, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(result_id) DO UPDATE SET masked_prompt=excluded.masked_prompt, masked_response=excluded.masked_response,
			tool_calls_json=excluded.tool_calls_json, headers_summary_json=excluded.headers_summary_json, export_hash=excluded.export_hash`),
		e.ID, e.ResultID, e.MaskedPrompt, e.MaskedResponse, string(tools), string(headers), e.ExportHash, e.CreatedAt)
	return err
}

func (s *SQLStore) RedTeamEvidenceByResult(ctx context.Context, resultID string) (RedTeamEvidence, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, result_id, masked_prompt, masked_response, tool_calls_json, headers_summary_json, export_hash, created_at
		FROM redteam_evidence WHERE result_id = ?`), resultID)
	var e RedTeamEvidence
	var tools, headers string
	err := row.Scan(&e.ID, &e.ResultID, &e.MaskedPrompt, &e.MaskedResponse, &tools, &headers, &e.ExportHash, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RedTeamEvidence{}, false, nil
	}
	if err != nil {
		return RedTeamEvidence{}, false, err
	}
	_ = json.Unmarshal([]byte(tools), &e.ToolCalls)
	if e.ToolCalls == nil {
		e.ToolCalls = []map[string]any{}
	}
	e.HeadersSummary = decodeJSONMap(headers)
	return e, true, nil
}

func (s *SQLStore) InsertRedTeamRemediation(ctx context.Context, r RedTeamRemediation) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	if r.UpdatedAt == "" {
		r.UpdatedAt = now
	}
	if r.Status == "" {
		r.Status = "open"
	}
	payload, _ := json.Marshal(nonNilMap(r.ActionPayload))
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_remediations
		(id, result_id, action_type, action_payload, status, owner, due_date, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET status=excluded.status, owner=excluded.owner, due_date=excluded.due_date, updated_at=excluded.updated_at`),
		r.ID, r.ResultID, r.ActionType, string(payload), r.Status, r.Owner, r.DueDate, r.CreatedAt, r.UpdatedAt)
	return err
}

func (s *SQLStore) ListRedTeamRemediations(ctx context.Context, limit int) ([]RedTeamRemediation, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, result_id, action_type, action_payload, status, owner, due_date, created_at, updated_at
		FROM redteam_remediations ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamRemediation{}
	for rows.Next() {
		var r RedTeamRemediation
		var payload string
		if err := rows.Scan(&r.ID, &r.ResultID, &r.ActionType, &payload, &r.Status, &r.Owner, &r.DueDate, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.ActionPayload = decodeJSONMap(payload)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertRedTeamBaseline(ctx context.Context, b RedTeamBaseline) error {
	if b.UpdatedAt == "" {
		b.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_baselines
		(id, target_id, pack_id, baseline_score, last_passed_at, drift_threshold, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(target_id, pack_id) DO UPDATE SET baseline_score=excluded.baseline_score,
			last_passed_at=excluded.last_passed_at, drift_threshold=excluded.drift_threshold, updated_at=excluded.updated_at`),
		b.ID, b.TargetID, b.PackID, b.BaselineScore, b.LastPassedAt, b.DriftThreshold, b.UpdatedAt)
	return err
}

func (s *SQLStore) ListRedTeamBaselines(ctx context.Context) ([]RedTeamBaseline, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, target_id, pack_id, baseline_score, last_passed_at, drift_threshold, updated_at
		FROM redteam_baselines ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamBaseline{}
	for rows.Next() {
		var b RedTeamBaseline
		if err := rows.Scan(&b.ID, &b.TargetID, &b.PackID, &b.BaselineScore, &b.LastPassedAt, &b.DriftThreshold, &b.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertRedTeamSchedule(ctx context.Context, sc RedTeamSchedule) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if sc.CreatedAt == "" {
		sc.CreatedAt = now
	}
	if sc.UpdatedAt == "" {
		sc.UpdatedAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_schedules
		(id, campaign_template_id, cron_expr, timezone, enabled, last_run_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET campaign_template_id=excluded.campaign_template_id, cron_expr=excluded.cron_expr,
			timezone=excluded.timezone, enabled=excluded.enabled, updated_at=excluded.updated_at`),
		sc.ID, sc.CampaignTemplateID, sc.CronExpr, sc.Timezone, boolInt(sc.Enabled), sc.LastRunAt, sc.CreatedAt, sc.UpdatedAt)
	return err
}

// RedTeamDashboardRow is one case result enriched with its target and probe-pack context,
// the join needed to build the target × pack result matrix and risk rollups. No prompt/response
// content is included — only decisions, categories, and scores.
type RedTeamDashboardRow struct {
	TargetID     string `json:"target_id"`
	TargetType   string `json:"target_type"`
	TargetRef    string `json:"target_ref"`
	OwnerTeam    string `json:"owner_team"`
	PackID       string `json:"pack_id"`
	PackCategory string `json:"pack_category"`
	Decision     string `json:"decision"`
	Severity     string `json:"severity"`
	RiskScore    int    `json:"risk_score"`
	CreatedAt    string `json:"created_at"`
}

// RedTeamDashboardRows returns recent case results joined to target and pack context, newest first.
func (s *SQLStore) RedTeamDashboardRows(ctx context.Context, limit int) ([]RedTeamDashboardRow, error) {
	if limit <= 0 || limit > 5000 {
		limit = 2000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT t.id, t.target_type, t.target_ref, t.owner_team,
			COALESCE(cs.pack_id, ''), COALESCE(p.category, ''),
			r.decision, r.severity, run.risk_score, r.created_at
		FROM redteam_case_results r
		JOIN redteam_runs run ON r.run_id = run.id
		JOIN redteam_targets t ON run.target_id = t.id
		LEFT JOIN redteam_probe_cases cs ON r.case_id = cs.id
		LEFT JOIN redteam_probe_packs p ON cs.pack_id = p.id
		ORDER BY r.created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamDashboardRow{}
	for rows.Next() {
		var d RedTeamDashboardRow
		if err := rows.Scan(&d.TargetID, &d.TargetType, &d.TargetRef, &d.OwnerTeam,
			&d.PackID, &d.PackCategory, &d.Decision, &d.Severity, &d.RiskScore, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// MarkRedTeamScheduleRun stamps a schedule's last_run_at so the scheduler spaces out fires and a
// failing schedule doesn't retry every tick.
func (s *SQLStore) MarkRedTeamScheduleRun(ctx context.Context, id, at string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE redteam_schedules SET last_run_at = ?, updated_at = ? WHERE id = ?`),
		at, at, id)
	return err
}

func (s *SQLStore) ListRedTeamSchedules(ctx context.Context) ([]RedTeamSchedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, campaign_template_id, cron_expr, timezone, enabled, last_run_at, created_at, updated_at
		FROM redteam_schedules ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RedTeamSchedule{}
	for rows.Next() {
		var sc RedTeamSchedule
		var enabled int
		if err := rows.Scan(&sc.ID, &sc.CampaignTemplateID, &sc.CronExpr, &sc.Timezone, &enabled, &sc.LastRunAt, &sc.CreatedAt, &sc.UpdatedAt); err != nil {
			return nil, err
		}
		sc.Enabled = enabled != 0
		out = append(out, sc)
	}
	return out, rows.Err()
}
