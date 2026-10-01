package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// These primitives preserve the existing single-policy upsert's normalization.
// Import validates separately and shares the same SQL, not a second writer.
func normalizeStoredPolicy(p Policy, now time.Time) Policy {
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
	return p
}

func normalizeStoredPolicyRule(r PolicyRule, policyID string, now time.Time) PolicyRule {
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	if r.PolicyID == "" {
		r.PolicyID = policyID
	}
	if r.Priority == 0 {
		r.Priority = 100
	}
	return r
}

func (s *SQLStore) upsertPolicyTx(ctx context.Context, tx *sql.Tx, p Policy) error {
	_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO policies (id, name, description, enabled, priority, rollout_percent, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			enabled = excluded.enabled,
			priority = excluded.priority,
			rollout_percent = excluded.rollout_percent,
			updated_at = excluded.updated_at`),
		p.ID, p.Name, p.Description, boolInt(p.Enabled), p.Priority, p.RolloutPercent, formatTime(p.CreatedAt), formatTime(p.UpdatedAt))
	return err
}

func (s *SQLStore) deletePolicyRulesTx(ctx context.Context, tx *sql.Tx, policyID string) error {
	_, err := tx.ExecContext(ctx, s.bind(`DELETE FROM policy_rules WHERE policy_id = ?`), policyID)
	return err
}

func (s *SQLStore) insertPolicyRuleTx(ctx context.Context, tx *sql.Tx, r PolicyRule) error {
	// Single-policy behavior is unchanged. Import prevalidates JSON encoding
	// before any write, including callers that do not enter through HTTP.
	conditions, _ := json.Marshal(nonNilMap(r.Conditions))
	actions, _ := json.Marshal(nonNilMap(r.Actions))
	_, err := tx.ExecContext(ctx, s.bind(`INSERT INTO policy_rules
		(id, policy_id, name, enabled, priority, conditions_json, actions_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		r.ID, r.PolicyID, r.Name, boolInt(r.Enabled), r.Priority, string(conditions), string(actions),
		formatTime(r.CreatedAt), formatTime(r.UpdatedAt))
	return err
}
