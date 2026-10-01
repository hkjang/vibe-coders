package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

const (
	MaxPolicyImportPolicies = 1000
	MaxPolicyImportRules    = 10000
)

// Code is fixed vocabulary; never includes IDs, policy contents or SQL errors.
type PolicyImportValidationError struct{ Code string }

func (e *PolicyImportValidationError) Error() string { return e.Code }

type PolicyImportPlan struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Action string `json:"action"`
	Rules  int    `json:"rules"`
}

type PolicyImportResult struct {
	DryRun  bool               `json:"dry_run"`
	Created int                `json:"created"`
	Updated int                `json:"updated"`
	Plan    []PolicyImportPlan `json:"plan"`
}

// ImportPolicies validates the entire input before writing, then changes all
// policies/rules in one transaction. It is not CAS, atomic audit or idempotency.
// A dry-run uses the identical input/ownership validation but never writes.
func (s *SQLStore) ImportPolicies(ctx context.Context, input []Policy, dryRun bool) (PolicyImportResult, error) {
	result := PolicyImportResult{DryRun: dryRun, Plan: []PolicyImportPlan{}}
	policies, replacing, ruleOwners, err := preparePolicyImport(input)
	if err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	ids := make([]string, 0, len(policies))
	for _, p := range policies {
		ids = append(ids, p.ID)
	}
	existing, err := s.policyImportIDs(ctx, tx, ids, false)
	if err != nil {
		return result, err
	}
	ruleIDs := make([]string, 0, len(ruleOwners))
	for id := range ruleOwners {
		ruleIDs = append(ruleIDs, id)
	}
	owners, err := s.policyImportIDs(ctx, tx, ruleIDs, true)
	if err != nil {
		return result, err
	}
	for id, owner := range owners {
		if owner != ruleOwners[id] && !replacing[owner] {
			return result, &PolicyImportValidationError{Code: "policy_rule_conflict"}
		}
	}
	for _, p := range policies {
		action := "create"
		if _, exists := existing[p.ID]; exists {
			action = "update"
			result.Updated++
		} else {
			result.Created++
		}
		result.Plan = append(result.Plan, PolicyImportPlan{ID: p.ID, Name: p.Name, Action: action, Rules: len(p.Rules)})
	}
	if dryRun {
		return result, nil
	}
	for _, p := range policies {
		if err := s.upsertPolicyTx(ctx, tx, p); err != nil {
			return result, err
		}
	}
	// Delete every explicit replacement before inserting any rule, allowing a
	// rule ID to move between replaced policies regardless of input order.
	for _, p := range policies {
		if p.Rules != nil {
			if err := s.deletePolicyRulesTx(ctx, tx, p.ID); err != nil {
				return result, err
			}
		}
	}
	for _, p := range policies {
		for _, r := range p.Rules {
			if err := s.insertPolicyRuleTx(ctx, tx, r); err != nil {
				return result, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	s.policies.invalidate()
	return result, nil
}

func preparePolicyImport(input []Policy) ([]Policy, map[string]bool, map[string]string, error) {
	invalid := func(code string) ([]Policy, map[string]bool, map[string]string, error) {
		return nil, nil, nil, &PolicyImportValidationError{Code: code}
	}
	if len(input) == 0 {
		return invalid("empty_payload")
	}
	if len(input) > MaxPolicyImportPolicies {
		return invalid("policy_import_limit")
	}
	policies := make([]Policy, 0, len(input))
	seen, replacing := map[string]bool{}, map[string]bool{}
	ruleOwners := map[string]string{}
	now := time.Now().UTC()
	totalRules := 0
	for _, original := range input {
		if strings.TrimSpace(original.ID) == "" || strings.TrimSpace(original.Name) == "" {
			return invalid("invalid_policy")
		}
		if seen[original.ID] {
			return invalid("duplicate_policy_id")
		}
		seen[original.ID] = true
		p := normalizeStoredPolicy(original, now)
		if original.Rules != nil {
			replacing[p.ID] = true
			p.Rules = make([]PolicyRule, 0, len(original.Rules))
		}
		totalRules += len(original.Rules)
		if totalRules > MaxPolicyImportRules {
			return invalid("policy_import_limit")
		}
		for _, rule := range original.Rules {
			if strings.TrimSpace(rule.ID) == "" || (rule.PolicyID != "" && rule.PolicyID != p.ID) {
				return invalid("invalid_policy_rule")
			}
			if _, exists := ruleOwners[rule.ID]; exists {
				return invalid("duplicate_rule_id")
			}
			if _, err := json.Marshal(nonNilMap(rule.Conditions)); err != nil {
				return invalid("invalid_policy_rule")
			}
			if _, err := json.Marshal(nonNilMap(rule.Actions)); err != nil {
				return invalid("invalid_policy_rule")
			}
			if !policyImportNumbersInRange(rule.Conditions) || !policyImportNumbersInRange(rule.Actions) {
				return invalid("invalid_policy_rule")
			}
			ruleOwners[rule.ID] = p.ID
			p.Rules = append(p.Rules, normalizeStoredPolicyRule(rule, p.ID, now))
		}
		policies = append(policies, p)
	}
	return policies, replacing, ruleOwners, nil
}

// Preserve the number token, but do not newly admit float64 overflow that the
// old typed JSON decode rejected and the unchanged runtime reader cannot load.
func policyImportNumbersInRange(value any) bool {
	switch value := value.(type) {
	case json.Number:
		_, err := value.Float64()
		return err == nil
	case map[string]any:
		for _, child := range value {
			if !policyImportNumbersInRange(child) {
				return false
			}
		}
	case []any:
		for _, child := range value {
			if !policyImportNumbersInRange(child) {
				return false
			}
		}
	}
	return true
}

// Bounded indexed lookup; chunks stay below both drivers' placeholder limits.
func (s *SQLStore) policyImportIDs(ctx context.Context, tx *sql.Tx, ids []string, rules bool) (map[string]string, error) {
	found := map[string]string{}
	for start := 0; start < len(ids); start += 250 {
		end := min(start+250, len(ids))
		args := make([]any, 0, end-start)
		for _, id := range ids[start:end] {
			args = append(args, id)
		}
		query := "SELECT id, id FROM policies WHERE id IN ("
		if rules {
			query = "SELECT id, policy_id FROM policy_rules WHERE id IN ("
		}
		query += strings.TrimSuffix(strings.Repeat("?,", len(args)), ",") + ")"
		rows, err := tx.QueryContext(ctx, s.bind(query), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, owner string
			if err := rows.Scan(&id, &owner); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = owner
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return found, nil
}
