package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"strings"
)

// PolicyExport changes only this endpoint's empty-rule representation. The
// embedded ordinary Policy type retains its existing omitempty wire contract.
type PolicyExport struct {
	Policy
	Rules []PolicyRule `json:"rules"`
}

// ExportPolicies reads parents and children in one statement's database
// snapshot. It does not turn subsequent import into CAS or whole-DB recovery.
func (s *SQLStore) ExportPolicies(ctx context.Context) ([]PolicyExport, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT
		p.id, p.name, COALESCE(p.description, ''), p.enabled, p.priority,
		COALESCE(p.rollout_percent, 100), p.created_at, p.updated_at,
		r.id, r.policy_id, r.name, r.enabled, r.priority,
		r.conditions_json, r.actions_json, r.created_at, r.updated_at
		FROM policies p LEFT JOIN policy_rules r ON r.policy_id = p.id
		ORDER BY p.priority ASC, p.created_at DESC, p.id ASC,
		r.priority ASC, r.created_at ASC, r.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []PolicyExport{}
	for rows.Next() {
		var p Policy
		var enabled int
		var createdAt, updatedAt string
		var id, owner, name, conditions, actions, ruleCreated, ruleUpdated sql.NullString
		var ruleEnabled, priority sql.NullInt64
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &enabled, &p.Priority, &p.RolloutPercent,
			&createdAt, &updatedAt, &id, &owner, &name, &ruleEnabled, &priority,
			&conditions, &actions, &ruleCreated, &ruleUpdated); err != nil {
			return nil, err
		}
		if len(result) == 0 || result[len(result)-1].ID != p.ID {
			p.Enabled = enabled == 1
			if p.RolloutPercent == 0 {
				p.RolloutPercent = 100
			}
			p.CreatedAt, p.UpdatedAt = parseOptionalTime(createdAt), parseOptionalTime(updatedAt)
			result = append(result, PolicyExport{Policy: p, Rules: []PolicyRule{}})
		}
		if !id.Valid {
			continue
		}
		r := PolicyRule{ID: id.String, PolicyID: owner.String, Name: name.String,
			Enabled: ruleEnabled.Int64 == 1, Priority: int(priority.Int64),
			CreatedAt: parseOptionalTime(ruleCreated.String), UpdatedAt: parseOptionalTime(ruleUpdated.String)}
		r.Conditions, err = decodeExportPolicyMap(conditions.String)
		if err != nil {
			return nil, err
		}
		r.Actions, err = decodeExportPolicyMap(actions.String)
		if err != nil {
			return nil, err
		}
		last := &result[len(result)-1]
		last.Rules = append(last.Rules, r)
	}
	return result, rows.Err()
}

func decodeExportPolicyMap(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var values map[string]any
	if err := decoder.Decode(&values); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return nonNilMap(values), nil
}
