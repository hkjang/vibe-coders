package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

func (s *SQLStore) ListPolicies(ctx context.Context) ([]Policy, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(description, ''), enabled, priority, COALESCE(rollout_percent, 100), created_at, updated_at
		FROM policies ORDER BY priority ASC, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	policies := []Policy{}
	for rows.Next() {
		p, err := scanPolicy(rows)
		if err != nil {
			return nil, err
		}
		policies = append(policies, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range policies {
		rules, err := s.policyRules(ctx, policies[i].ID, false)
		if err != nil {
			return nil, err
		}
		policies[i].Rules = rules
	}
	return policies, nil
}

func (s *SQLStore) UpsertPolicyWithRules(ctx context.Context, p Policy, rules []PolicyRule) error {
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	if p.Priority == 0 {
		p.Priority = 100
	}
	if p.RolloutPercent <= 0 || p.RolloutPercent > 100 {
		p.RolloutPercent = 100
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO policies (id, name, description, enabled, priority, rollout_percent, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			enabled = excluded.enabled,
			priority = excluded.priority,
			rollout_percent = excluded.rollout_percent,
			updated_at = excluded.updated_at`),
		p.ID, p.Name, p.Description, boolInt(p.Enabled), p.Priority, p.RolloutPercent, formatTime(p.CreatedAt), formatTime(p.UpdatedAt))
	if err != nil {
		return err
	}
	if rules != nil {
		if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM policy_rules WHERE policy_id = ?`), p.ID); err != nil {
			return err
		}
		for _, rule := range rules {
			if rule.CreatedAt.IsZero() {
				rule.CreatedAt = now
			}
			rule.UpdatedAt = now
			if rule.PolicyID == "" {
				rule.PolicyID = p.ID
			}
			if rule.Priority == 0 {
				rule.Priority = 100
			}
			conditions, _ := json.Marshal(nonNilMap(rule.Conditions))
			actions, _ := json.Marshal(nonNilMap(rule.Actions))
			if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO policy_rules
				(id, policy_id, name, enabled, priority, conditions_json, actions_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
				rule.ID, rule.PolicyID, rule.Name, boolInt(rule.Enabled), rule.Priority, string(conditions), string(actions),
				formatTime(rule.CreatedAt), formatTime(rule.UpdatedAt)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (s *SQLStore) ActivePolicyRules(ctx context.Context) ([]PolicyRule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id, r.policy_id, COALESCE(r.name, ''), r.enabled, r.priority,
			r.conditions_json, r.actions_json, r.created_at, r.updated_at, COALESCE(p.rollout_percent, 100)
		FROM policy_rules r
		JOIN policies p ON p.id = r.policy_id
		WHERE p.enabled = 1 AND r.enabled = 1
		ORDER BY p.priority ASC, r.priority ASC, r.created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []PolicyRule{}
	for rows.Next() {
		var r PolicyRule
		var enabled int
		var conditions, actions, createdAt, updatedAt string
		if err := rows.Scan(&r.ID, &r.PolicyID, &r.Name, &enabled, &r.Priority, &conditions, &actions, &createdAt, &updatedAt, &r.RolloutPercent); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		if r.RolloutPercent == 0 {
			r.RolloutPercent = 100
		}
		r.Conditions = decodeJSONMap(conditions)
		r.Actions = decodeJSONMap(actions)
		r.CreatedAt = parseOptionalTime(createdAt)
		r.UpdatedAt = parseOptionalTime(updatedAt)
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *SQLStore) policyRules(ctx context.Context, policyID string, activeOnly bool) ([]PolicyRule, error) {
	where := "policy_id = ?"
	if activeOnly {
		where += " AND enabled = 1"
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, policy_id, COALESCE(name, ''), enabled, priority,
			conditions_json, actions_json, created_at, updated_at
		FROM policy_rules WHERE `+where+` ORDER BY priority ASC, created_at ASC`), policyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPolicyRules(rows)
}

func scanPolicy(rows *sql.Rows) (Policy, error) {
	var p Policy
	var enabled int
	var createdAt, updatedAt string
	if err := rows.Scan(&p.ID, &p.Name, &p.Description, &enabled, &p.Priority, &p.RolloutPercent, &createdAt, &updatedAt); err != nil {
		return Policy{}, err
	}
	p.Enabled = enabled == 1
	if p.RolloutPercent == 0 {
		p.RolloutPercent = 100
	}
	p.CreatedAt = parseOptionalTime(createdAt)
	p.UpdatedAt = parseOptionalTime(updatedAt)
	return p, nil
}

func scanPolicyRules(rows *sql.Rows) ([]PolicyRule, error) {
	result := []PolicyRule{}
	for rows.Next() {
		var r PolicyRule
		var enabled int
		var conditions, actions, createdAt, updatedAt string
		if err := rows.Scan(&r.ID, &r.PolicyID, &r.Name, &enabled, &r.Priority, &conditions, &actions, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		r.Conditions = decodeJSONMap(conditions)
		r.Actions = decodeJSONMap(actions)
		r.CreatedAt = parseOptionalTime(createdAt)
		r.UpdatedAt = parseOptionalTime(updatedAt)
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertPolicyDecisionEvent(ctx context.Context, e PolicyDecisionEvent) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO policy_decision_events
		(id, request_id, api_key_id, user_id, team_id, endpoint, phase, policy_id, rule_id, rule_name,
		 decision, reason, model, provider, risk_score, complexity_score, cost_krw, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.RequestID, e.APIKeyID, e.UserID, e.TeamID, e.Endpoint, e.Phase, e.PolicyID, e.RuleID, e.RuleName,
		e.Decision, e.Reason, e.Model, e.Provider, e.RiskScore, e.ComplexityScore, e.CostKRW, formatTime(e.CreatedAt))
	return err
}

func (s *SQLStore) ListPolicyDecisionEvents(ctx context.Context, limit int) ([]PolicyDecisionEvent, error) {
	return s.ListPolicyDecisionEventsFiltered(ctx, PolicyDecisionFilter{Limit: limit})
}

func (s *SQLStore) ListPolicyDecisionEventsFiltered(ctx context.Context, f PolicyDecisionFilter) ([]PolicyDecisionEvent, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, formatTime(f.Since.UTC()))
	}
	addEq := func(column, value string) {
		if value == "" {
			return
		}
		where = append(where, column+" = ?")
		args = append(args, value)
	}
	addEq("request_id", f.RequestID)
	addEq("api_key_id", f.APIKeyID)
	addEq("user_id", f.UserID)
	addEq("team_id", f.TeamID)
	addEq("endpoint", f.Endpoint)
	addEq("phase", f.Phase)
	addEq("policy_id", f.PolicyID)
	addEq("rule_id", f.RuleID)
	addEq("model", f.Model)
	addEq("provider", f.Provider)
	if f.Decision != "" {
		where = append(where, "LOWER(decision) = LOWER(?)")
		args = append(args, f.Decision)
	}
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''),
			COALESCE(user_id, ''), COALESCE(team_id, ''), COALESCE(endpoint, ''), COALESCE(phase, ''),
			COALESCE(policy_id, ''), COALESCE(rule_id, ''), COALESCE(rule_name, ''), decision, COALESCE(reason, ''),
			COALESCE(model, ''), COALESCE(provider, ''), risk_score, complexity_score, cost_krw, created_at
		FROM policy_decision_events WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPolicyDecisionEvents(rows)
}

func (s *SQLStore) PolicyDecisionEventsForRequest(ctx context.Context, requestID string) ([]PolicyDecisionEvent, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''),
			COALESCE(user_id, ''), COALESCE(team_id, ''), COALESCE(endpoint, ''), COALESCE(phase, ''),
			COALESCE(policy_id, ''), COALESCE(rule_id, ''), COALESCE(rule_name, ''), decision, COALESCE(reason, ''),
			COALESCE(model, ''), COALESCE(provider, ''), risk_score, complexity_score, cost_krw, created_at
		FROM policy_decision_events WHERE request_id = ? ORDER BY created_at DESC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPolicyDecisionEvents(rows)
}

func scanPolicyDecisionEvents(rows *sql.Rows) ([]PolicyDecisionEvent, error) {
	result := []PolicyDecisionEvent{}
	for rows.Next() {
		var e PolicyDecisionEvent
		var createdAt string
		if err := rows.Scan(&e.ID, &e.RequestID, &e.APIKeyID, &e.UserID, &e.TeamID, &e.Endpoint, &e.Phase,
			&e.PolicyID, &e.RuleID, &e.RuleName, &e.Decision, &e.Reason, &e.Model, &e.Provider,
			&e.RiskScore, &e.ComplexityScore, &e.CostKRW, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, e)
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertApproval(ctx context.Context, a Approval) error {
	now := time.Now().UTC()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	if a.Status == "" {
		a.Status = "pending"
	}
	if a.ExpiresAt.IsZero() && a.Status == "pending" {
		a.ExpiresAt = now.Add(24 * time.Hour)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO approvals
		(id, request_id, api_key_id, user_id, team_id, subject_type, subject_id, status, reason, risk_score, cost_krw, payload, expires_at, decided_by, decided_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		a.ID, a.RequestID, a.APIKeyID, a.UserID, a.TeamID, a.SubjectType, a.SubjectID, a.Status, a.Reason,
		a.RiskScore, a.CostKRW, a.Payload, formatOptionalTime(a.ExpiresAt), a.DecidedBy, formatOptionalTime(a.DecidedAt), formatTime(a.CreatedAt))
	return err
}

func (s *SQLStore) ListApprovals(ctx context.Context, status string, limit int) ([]Approval, error) {
	return s.ListApprovalsFiltered(ctx, ApprovalFilter{Status: status, Limit: limit})
}

func (s *SQLStore) ListApprovalsFiltered(ctx context.Context, f ApprovalFilter) ([]Approval, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, formatTime(f.Since.UTC()))
	}
	addEq := func(column, value string) {
		if value == "" {
			return
		}
		where = append(where, column+" = ?")
		args = append(args, value)
	}
	addEq("id", f.ID)
	addEq("request_id", f.RequestID)
	addEq("api_key_id", f.APIKeyID)
	addEq("user_id", f.UserID)
	addEq("team_id", f.TeamID)
	addEq("subject_type", f.SubjectType)
	addEq("subject_id", f.SubjectID)
	addEq("decided_by", f.DecidedBy)
	if f.Status != "" {
		where = append(where, "LOWER(status) = LOWER(?)")
		args = append(args, f.Status)
	}
	if f.Reason != "" {
		where = append(where, "LOWER(COALESCE(reason, '')) LIKE LOWER(?)")
		args = append(args, "%"+f.Reason+"%")
	}
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''), COALESCE(user_id, ''),
			COALESCE(team_id, ''), COALESCE(subject_type, ''), COALESCE(subject_id, ''), status, COALESCE(reason, ''),
			risk_score, cost_krw, COALESCE(payload, ''), COALESCE(expires_at, ''), COALESCE(decided_by, ''),
			COALESCE(decided_at, ''), created_at
		FROM approvals WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanApprovals(rows)
}

func (s *SQLStore) ApprovalsForRequest(ctx context.Context, requestID string) ([]Approval, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''), COALESCE(user_id, ''),
			COALESCE(team_id, ''), COALESCE(subject_type, ''), COALESCE(subject_id, ''), status, COALESCE(reason, ''),
			risk_score, cost_krw, COALESCE(payload, ''), COALESCE(expires_at, ''), COALESCE(decided_by, ''),
			COALESCE(decided_at, ''), created_at
		FROM approvals WHERE request_id = ? ORDER BY created_at DESC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanApprovals(rows)
}

func (s *SQLStore) GetApproval(ctx context.Context, id string) (Approval, bool, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''), COALESCE(user_id, ''),
			COALESCE(team_id, ''), COALESCE(subject_type, ''), COALESCE(subject_id, ''), status, COALESCE(reason, ''),
			risk_score, cost_krw, COALESCE(payload, ''), COALESCE(expires_at, ''), COALESCE(decided_by, ''),
			COALESCE(decided_at, ''), created_at
		FROM approvals WHERE id = ?`), id)
	if err != nil {
		return Approval{}, false, err
	}
	defer rows.Close()
	items, err := scanApprovals(rows)
	if err != nil {
		return Approval{}, false, err
	}
	if len(items) == 0 {
		return Approval{}, false, nil
	}
	return items[0], true, nil
}

func (s *SQLStore) ExpireApprovals(ctx context.Context, now time.Time) (int64, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE approvals
		SET status = 'expired',
			decided_by = CASE WHEN COALESCE(decided_by, '') = '' THEN 'system' ELSE decided_by END,
			decided_at = ?
		WHERE status IN ('pending', 'approved')
			AND COALESCE(expires_at, '') <> ''
			AND expires_at <= ?`), formatTime(now), formatTime(now))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLStore) SetApprovalStatus(ctx context.Context, id, status, decidedBy string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`),
		status, decidedBy, formatTime(time.Now().UTC()), id)
	return err
}

func (s *SQLStore) SetPendingApprovalStatus(ctx context.Context, id, status, decidedBy string) (bool, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
		WHERE id = ? AND status = 'pending'`), status, decidedBy, formatTime(time.Now().UTC()), id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func scanApprovals(rows *sql.Rows) ([]Approval, error) {
	result := []Approval{}
	for rows.Next() {
		var a Approval
		var expiresAt, decidedAt, createdAt string
		if err := rows.Scan(&a.ID, &a.RequestID, &a.APIKeyID, &a.UserID, &a.TeamID, &a.SubjectType, &a.SubjectID,
			&a.Status, &a.Reason, &a.RiskScore, &a.CostKRW, &a.Payload, &expiresAt, &a.DecidedBy, &decidedAt, &createdAt); err != nil {
			return nil, err
		}
		a.ExpiresAt = parseOptionalTime(expiresAt)
		a.DecidedAt = parseOptionalTime(decidedAt)
		a.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, a)
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertSecretEvent(ctx context.Context, e SecretEvent) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO secret_events
		(id, request_id, api_key_id, user_id, team_id, secret_type, action, location, matched_hash, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.RequestID, e.APIKeyID, e.UserID, e.TeamID, e.SecretType, e.Action, e.Location, e.MatchedHash, formatTime(e.CreatedAt))
	return err
}

func (s *SQLStore) ListSecretEvents(ctx context.Context, limit int) ([]SecretEvent, error) {
	return s.ListSecretEventsFiltered(ctx, SecretEventFilter{Limit: limit})
}

func (s *SQLStore) ListSecretEventsFiltered(ctx context.Context, f SecretEventFilter) ([]SecretEvent, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, formatTime(f.Since.UTC()))
	}
	addEq := func(column, value string) {
		if value == "" {
			return
		}
		where = append(where, column+" = ?")
		args = append(args, value)
	}
	addEq("request_id", f.RequestID)
	addEq("api_key_id", f.APIKeyID)
	addEq("user_id", f.UserID)
	addEq("team_id", f.TeamID)
	addEq("matched_hash", f.MatchedHash)
	if f.SecretType != "" {
		where = append(where, "LOWER(secret_type) = LOWER(?)")
		args = append(args, f.SecretType)
	}
	if f.Action != "" {
		where = append(where, "LOWER(action) = LOWER(?)")
		args = append(args, f.Action)
	}
	if f.Location != "" {
		where = append(where, "LOWER(COALESCE(location, '')) LIKE LOWER(?)")
		args = append(args, "%"+f.Location+"%")
	}
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''),
			COALESCE(user_id, ''), COALESCE(team_id, ''), secret_type, action, COALESCE(location, ''),
			COALESCE(matched_hash, ''), created_at
		FROM secret_events WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSecretEvents(rows)
}

func scanSecretEvents(rows *sql.Rows) ([]SecretEvent, error) {
	result := []SecretEvent{}
	for rows.Next() {
		var e SecretEvent
		var createdAt string
		if err := rows.Scan(&e.ID, &e.RequestID, &e.APIKeyID, &e.UserID, &e.TeamID, &e.SecretType, &e.Action, &e.Location, &e.MatchedHash, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, e)
	}
	return result, rows.Err()
}

func (s *SQLStore) SecretEventsForRequest(ctx context.Context, requestID string) ([]SecretEvent, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id, ''), COALESCE(api_key_id, ''),
			COALESCE(user_id, ''), COALESCE(team_id, ''), secret_type, action, COALESCE(location, ''),
			COALESCE(matched_hash, ''), created_at
		FROM secret_events WHERE request_id = ? ORDER BY created_at DESC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSecretEvents(rows)
}

func (s *SQLStore) UpsertToolRiskProfile(ctx context.Context, p ToolRiskProfile) error {
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	if p.ID == "" {
		p.ID = "trp_" + auditHash(p.ServerLabel+"|"+p.ToolName)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO tool_risk_profiles
		(id, server_label, tool_name, risk_level, action, note, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(server_label, tool_name) DO UPDATE SET
			risk_level = excluded.risk_level,
			action = excluded.action,
			note = excluded.note,
			updated_at = excluded.updated_at`),
		p.ID, p.ServerLabel, p.ToolName, p.RiskLevel, p.Action, p.Note, formatTime(p.CreatedAt), formatTime(p.UpdatedAt))
	return err
}

func (s *SQLStore) ListToolRiskProfiles(ctx context.Context) ([]ToolRiskProfile, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, server_label, tool_name, risk_level, action, COALESCE(note, ''), created_at, updated_at
		FROM tool_risk_profiles ORDER BY server_label ASC, tool_name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanToolRiskProfiles(rows)
}

func (s *SQLStore) ToolRiskProfile(ctx context.Context, serverLabel, toolName string) (ToolRiskProfile, bool, error) {
	candidates := [][2]string{
		{serverLabel, toolName},
		{serverLabel, "*"},
		{"*", toolName},
		{"*", "*"},
	}
	for _, cand := range candidates {
		rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, server_label, tool_name, risk_level, action, COALESCE(note, ''), created_at, updated_at
			FROM tool_risk_profiles WHERE server_label = ? AND tool_name = ? LIMIT 1`), cand[0], cand[1])
		if err != nil {
			return ToolRiskProfile{}, false, err
		}
		items, scanErr := scanToolRiskProfiles(rows)
		rows.Close()
		if scanErr != nil {
			return ToolRiskProfile{}, false, scanErr
		}
		if len(items) > 0 {
			return items[0], true, nil
		}
	}
	return ToolRiskProfile{}, false, nil
}

func scanToolRiskProfiles(rows *sql.Rows) ([]ToolRiskProfile, error) {
	result := []ToolRiskProfile{}
	for rows.Next() {
		var p ToolRiskProfile
		var createdAt, updatedAt string
		if err := rows.Scan(&p.ID, &p.ServerLabel, &p.ToolName, &p.RiskLevel, &p.Action, &p.Note, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.CreatedAt = parseOptionalTime(createdAt)
		p.UpdatedAt = parseOptionalTime(updatedAt)
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertReplayJob(ctx context.Context, job ReplayJob) error {
	if job.CreatedAt.IsZero() {
		job.CreatedAt = time.Now().UTC()
	}
	if job.Status == "" {
		job.Status = "pending"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO replay_jobs
		(id, source_request_id, prompt, models, status, results, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		job.ID, job.SourceRequestID, job.Prompt, encodeStringList(job.Models), job.Status, job.Results, job.CreatedBy, formatTime(job.CreatedAt))
	return err
}

func (s *SQLStore) UpdateReplayJob(ctx context.Context, id, status, results string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE replay_jobs SET status = ?, results = ? WHERE id = ?`), status, results, id)
	return err
}

func (s *SQLStore) ListReplayJobs(ctx context.Context, limit int) ([]ReplayJob, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(source_request_id, ''), prompt, models, status, COALESCE(results, ''), COALESCE(created_by, ''), created_at
		FROM replay_jobs ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ReplayJob{}
	for rows.Next() {
		var job ReplayJob
		var models, createdAt string
		if err := rows.Scan(&job.ID, &job.SourceRequestID, &job.Prompt, &models, &job.Status, &job.Results, &job.CreatedBy, &createdAt); err != nil {
			return nil, err
		}
		job.Models = decodeStringList(models)
		job.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, job)
	}
	return result, rows.Err()
}

func (s *SQLStore) ListGoldenPrompts(ctx context.Context) ([]GoldenPrompt, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, prompt, COALESCE(expected, ''), COALESCE(tags, '[]'), created_at, updated_at
		FROM golden_prompts ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []GoldenPrompt{}
	for rows.Next() {
		var p GoldenPrompt
		var tags, createdAt, updatedAt string
		if err := rows.Scan(&p.ID, &p.Name, &p.Prompt, &p.Expected, &tags, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.Tags = decodeStringList(tags)
		p.CreatedAt = parseOptionalTime(createdAt)
		p.UpdatedAt = parseOptionalTime(updatedAt)
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertGoldenPrompt(ctx context.Context, p GoldenPrompt) error {
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO golden_prompts (id, name, prompt, expected, tags, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			prompt = excluded.prompt,
			expected = excluded.expected,
			tags = excluded.tags,
			updated_at = excluded.updated_at`),
		p.ID, p.Name, p.Prompt, p.Expected, encodeStringList(p.Tags), formatTime(p.CreatedAt), formatTime(p.UpdatedAt))
	return err
}

func (s *SQLStore) ListGoldenWorkflows(ctx context.Context) ([]GoldenWorkflow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(description, ''), COALESCE(steps, '[]'), COALESCE(tags, '[]'), created_at, updated_at
		FROM golden_workflows ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []GoldenWorkflow{}
	for rows.Next() {
		w, err := scanGoldenWorkflow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, w)
	}
	return result, rows.Err()
}

func (s *SQLStore) GetGoldenWorkflow(ctx context.Context, id string) (GoldenWorkflow, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, COALESCE(description, ''), COALESCE(steps, '[]'), COALESCE(tags, '[]'), created_at, updated_at
		FROM golden_workflows WHERE id = ?`), id)
	return scanGoldenWorkflow(row)
}

// scanGoldenWorkflow decodes a workflow row from either *sql.Rows or *sql.Row.
func scanGoldenWorkflow(sc interface{ Scan(...any) error }) (GoldenWorkflow, error) {
	var w GoldenWorkflow
	var steps, tags, createdAt, updatedAt string
	if err := sc.Scan(&w.ID, &w.Name, &w.Description, &steps, &tags, &createdAt, &updatedAt); err != nil {
		return GoldenWorkflow{}, err
	}
	if err := json.Unmarshal([]byte(steps), &w.Steps); err != nil {
		w.Steps = nil
	}
	w.Tags = decodeStringList(tags)
	w.CreatedAt = parseOptionalTime(createdAt)
	w.UpdatedAt = parseOptionalTime(updatedAt)
	return w, nil
}

func (s *SQLStore) UpsertGoldenWorkflow(ctx context.Context, w GoldenWorkflow) error {
	now := time.Now().UTC()
	if w.CreatedAt.IsZero() {
		w.CreatedAt = now
	}
	w.UpdatedAt = now
	steps, err := json.Marshal(w.Steps)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.bind(`INSERT INTO golden_workflows (id, name, description, steps, tags, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			steps = excluded.steps,
			tags = excluded.tags,
			updated_at = excluded.updated_at`),
		w.ID, w.Name, w.Description, string(steps), encodeStringList(w.Tags), formatTime(w.CreatedAt), formatTime(w.UpdatedAt))
	return err
}

func (s *SQLStore) DeleteGoldenWorkflow(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM golden_workflows WHERE id = ?`), id)
	return err
}

func (s *SQLStore) InsertGoldenPromptResult(ctx context.Context, r GoldenPromptResult) error {
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO golden_prompt_results
		(id, prompt_id, model, score, passed, cost_krw, latency_ms, response, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		r.ID, r.PromptID, r.Model, r.Score, boolInt(r.Passed), r.CostKRW, r.LatencyMS, r.Response, formatTime(r.CreatedAt))
	return err
}

func (s *SQLStore) ListGoldenPromptResults(ctx context.Context, promptID string, limit int) ([]GoldenPromptResult, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	where := "1=1"
	args := []any{}
	if promptID != "" {
		where = "prompt_id = ?"
		args = append(args, promptID)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, prompt_id, model, score, passed, cost_krw, latency_ms, COALESCE(response, ''), created_at
		FROM golden_prompt_results WHERE `+where+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []GoldenPromptResult{}
	for rows.Next() {
		var r GoldenPromptResult
		var passed int
		var createdAt string
		if err := rows.Scan(&r.ID, &r.PromptID, &r.Model, &r.Score, &passed, &r.CostKRW, &r.LatencyMS, &r.Response, &createdAt); err != nil {
			return nil, err
		}
		r.Passed = passed == 1
		r.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *SQLStore) InsertAnomalyEvent(ctx context.Context, e AnomalyEvent) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	if e.Status == "" {
		e.Status = "open"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO anomaly_events
		(id, scope, scope_value, metric, value, baseline, severity, channel, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.Scope, e.ScopeValue, e.Metric, e.Value, e.Baseline, e.Severity, e.Channel, e.Status, formatTime(e.CreatedAt))
	return err
}

func (s *SQLStore) RecentAnomalyEventExists(ctx context.Context, scope, scopeValue, metric string, since time.Time) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM anomaly_events
		WHERE scope = ? AND scope_value = ? AND metric = ? AND created_at >= ?`),
		scope, scopeValue, metric, formatTime(since)).Scan(&n)
	return n > 0, err
}

func (s *SQLStore) AnomalyEventsForRequest(ctx context.Context, requestID string, window time.Duration) ([]AnomalyEvent, error) {
	if window <= 0 {
		window = time.Hour
	}
	var apiKeyID, team, model, createdAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(r.api_key_id, ''), COALESCE(k.team, ''), COALESCE(r.model, ''), r.created_at
		FROM request_logs r
		LEFT JOIN api_keys k ON k.id = r.api_key_id
		WHERE r.id = ?`), requestID).Scan(&apiKeyID, &team, &model, &createdAt)
	if err == sql.ErrNoRows {
		return []AnomalyEvent{}, nil
	}
	if err != nil {
		return nil, err
	}
	center := parseOptionalTime(createdAt)
	if center.IsZero() {
		center = time.Now().UTC()
	}
	start := center.Add(-window).Format(time.RFC3339Nano)
	end := center.Add(window).Format(time.RFC3339Nano)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, scope, COALESCE(scope_value, ''), metric, value, baseline, severity,
			COALESCE(channel, ''), status, created_at
		FROM anomaly_events
		WHERE created_at >= ? AND created_at <= ? AND (
			scope = 'global'
			OR (scope = 'api_key' AND scope_value = ?)
			OR (scope = 'team' AND scope_value = ?)
			OR (scope = 'model' AND scope_value = ?)
		)
		ORDER BY created_at DESC LIMIT 50`), start, end, apiKeyID, team, model)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAnomalyEvents(rows)
}

func (s *SQLStore) ListAnomalyEvents(ctx context.Context, limit int) ([]AnomalyEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, scope, COALESCE(scope_value, ''), metric, value, baseline, severity,
			COALESCE(channel, ''), status, created_at
		FROM anomaly_events ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAnomalyEvents(rows)
}

func scanAnomalyEvents(rows *sql.Rows) ([]AnomalyEvent, error) {
	result := []AnomalyEvent{}
	for rows.Next() {
		var e AnomalyEvent
		var createdAt string
		if err := rows.Scan(&e.ID, &e.Scope, &e.ScopeValue, &e.Metric, &e.Value, &e.Baseline, &e.Severity, &e.Channel, &e.Status, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = parseOptionalTime(createdAt)
		result = append(result, e)
	}
	return result, rows.Err()
}

func (s *SQLStore) ActiveContextRegistry(ctx context.Context) ([]ContextRegistryEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, key, name, content, enabled, token_estimate, use_count,
			COALESCE(last_used_at, ''), created_at, updated_at
		FROM context_registry WHERE enabled = 1 ORDER BY key ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanContextRegistry(rows)
}

func (s *SQLStore) ListContextRegistry(ctx context.Context) ([]ContextRegistryEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, key, name, content, enabled, token_estimate, use_count,
			COALESCE(last_used_at, ''), created_at, updated_at
		FROM context_registry ORDER BY key ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanContextRegistry(rows)
}

func scanContextRegistry(rows *sql.Rows) ([]ContextRegistryEntry, error) {
	result := []ContextRegistryEntry{}
	for rows.Next() {
		var e ContextRegistryEntry
		var enabled int
		var lastUsedAt, createdAt, updatedAt string
		if err := rows.Scan(&e.ID, &e.Key, &e.Name, &e.Content, &enabled, &e.TokenEstimate, &e.UseCount, &lastUsedAt, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		e.Enabled = enabled == 1
		e.LastUsedAt = parseOptionalTime(lastUsedAt)
		e.CreatedAt = parseOptionalTime(createdAt)
		e.UpdatedAt = parseOptionalTime(updatedAt)
		result = append(result, e)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertContextRegistry(ctx context.Context, e ContextRegistryEntry) error {
	now := time.Now().UTC()
	if e.CreatedAt.IsZero() {
		e.CreatedAt = now
	}
	e.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO context_registry
		(id, key, name, content, enabled, token_estimate, use_count, last_used_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			name = excluded.name,
			content = excluded.content,
			enabled = excluded.enabled,
			token_estimate = excluded.token_estimate,
			updated_at = excluded.updated_at`),
		e.ID, e.Key, e.Name, e.Content, boolInt(e.Enabled), e.TokenEstimate, e.UseCount, formatOptionalTime(e.LastUsedAt),
		formatTime(e.CreatedAt), formatTime(e.UpdatedAt))
	return err
}

func (s *SQLStore) TouchContextRegistry(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	now := formatTime(time.Now().UTC())
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE context_registry SET use_count = use_count + 1, last_used_at = ? WHERE key = ?`), now, key); err != nil {
			return err
		}
	}
	return nil
}

func nonNilMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func decodeJSONMap(raw string) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &out)
	if out == nil {
		out = map[string]any{}
	}
	return out
}
