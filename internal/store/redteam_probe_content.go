package store

import (
	"context"
	"encoding/json"
	"time"
)

// UpsertRedTeamProbePackContent updates fields represented by CSV and the prompt
// editor. Existing execution controls and creation provenance are untouched.
// Excluding those columns from ON CONFLICT preserves their current database
// values without a read/restore race. New packs use the caller's normal defaults.
func (s *SQLStore) UpsertRedTeamProbePackContent(ctx context.Context, pack RedTeamProbePack) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if pack.CreatedAt == "" {
		pack.CreatedAt = now
	}
	if pack.UpdatedAt == "" {
		pack.UpdatedAt = now
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_probe_packs
  (id, name, category, severity, version, enabled, requires_approval, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category,
   severity=excluded.severity, requires_approval=excluded.requires_approval,
   updated_at=excluded.updated_at`),
		pack.ID, pack.Name, pack.Category, pack.Severity, pack.Version, boolInt(pack.Enabled),
		boolInt(pack.RequiresApproval), pack.CreatedBy, pack.CreatedAt, pack.UpdatedAt)
	return err
}

// UpsertRedTeamProbeCaseContent applies an editable prompt without replacing
// parameters that CSV and the manual prompt form cannot represent. It never
// deletes other cases; full UpsertRedTeamProbeCase retains replacement semantics.
func (s *SQLStore) UpsertRedTeamProbeCaseContent(ctx context.Context, c RedTeamProbeCase) error {
	if c.ID == "" || c.PackID == "" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if c.CreatedAt == "" {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	params, _ := json.Marshal(nonNilMap(c.Parameters))
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO redteam_probe_cases
  (id, pack_id, case_key, input_template, expected_policy, evaluator_type, severity, risk_tags, target_types, parameters_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET pack_id=excluded.pack_id, case_key=excluded.case_key, input_template=excluded.input_template,
   expected_policy=excluded.expected_policy, evaluator_type=excluded.evaluator_type, severity=excluded.severity,
   risk_tags=excluded.risk_tags, target_types=excluded.target_types, updated_at=excluded.updated_at`),
		c.ID, c.PackID, c.CaseKey, c.InputTemplate, c.ExpectedPolicy, c.EvaluatorType, c.Severity,
		encodeStringList(c.RiskTags), encodeStringList(c.TargetTypes), string(params), c.CreatedAt, c.UpdatedAt)
	return err
}
