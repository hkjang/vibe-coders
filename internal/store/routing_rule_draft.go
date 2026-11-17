package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode/utf8"
)

var ErrRoutingDraftAmbiguous = errors.New("routing draft has ambiguous rule precedence")

// The draft is an immutable copy of stored rules, not the live cache. Raw
// creation strings retain the existing SQL precedence when priorities change.
type RoutingRuleDraft struct {
	Before         RoutingOrderSnapshot
	Rules          []RoutingRule
	Original       RoutingRule
	Rule           RoutingRule
	ResultRevision string
}

func (s *SQLStore) PreviewRoutingRuleEdit(ctx context.Context, revision, id string, patch RoutingRulePatch) (RoutingRuleDraft, error) {
	return s.routingRuleDraft(ctx, s.db, revision, id, patch)
}

func (s *SQLStore) routingRuleDraft(ctx context.Context, db routingOrderQueryer, revision, id string, patch RoutingRulePatch) (RoutingRuleDraft, error) {
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != sha256.Size || !validRoutingOrderID(id) || patch.Enabled != nil {
		return RoutingRuleDraft{}, ErrRoutingOrderInvalid
	}
	var stored []routingOrderStored
	before, err := s.routingOrderSnapshotWithStored(ctx, db, &stored)
	if err != nil {
		return RoutingRuleDraft{}, err
	}
	if before.Revision != revision {
		return RoutingRuleDraft{}, ErrRoutingOrderConflict
	}
	if before.AmbiguousTies {
		return RoutingRuleDraft{}, ErrRoutingDraftAmbiguous
	}
	result := RoutingRuleDraft{Before: before}
	found := false
	for i := range stored {
		if stored[i].ID != id {
			continue
		}
		found = true
		result.Original = stored[i].RoutingRule
		next, err := applyRoutingRuleDraft(result.Original, patch)
		if err != nil {
			return RoutingRuleDraft{}, err
		}
		result.Rule = next
		stored[i].RoutingRule = next
	}
	if !found {
		return RoutingRuleDraft{}, ErrRoutingRuleNotFound
	}
	sort.SliceStable(stored, func(i, j int) bool {
		if stored[i].Priority != stored[j].Priority {
			return stored[i].Priority < stored[j].Priority
		}
		return stored[i].RawCreatedAt < stored[j].RawCreatedAt
	})
	for i, item := range stored {
		if i > 0 && item.Priority == stored[i-1].Priority && item.RawCreatedAt == stored[i-1].RawCreatedAt {
			return RoutingRuleDraft{}, ErrRoutingDraftAmbiguous
		}
		result.Rules = append(result.Rules, item.RoutingRule)
	}
	sort.Slice(stored, func(i, j int) bool { return stored[i].ID < stored[j].ID })
	encoded, err := json.Marshal(stored)
	if err != nil {
		return RoutingRuleDraft{}, err
	}
	digest := sha256.Sum256(encoded)
	result.ResultRevision = hex.EncodeToString(digest[:])
	return result, nil
}

func applyRoutingRuleDraft(rule RoutingRule, p RoutingRulePatch) (RoutingRule, error) {
	before := rule
	for _, field := range []struct {
		input  *string
		target *string
		limit  int
	}{
		{p.MatchPattern, &rule.MatchPattern, 200}, {p.TargetModel, &rule.TargetModel, 256},
		{p.TargetProvider, &rule.TargetProvider, 120}, {p.Note, &rule.Note, 500},
	} {
		if field.input == nil {
			continue
		}
		value := strings.TrimSpace(*field.input)
		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > field.limit {
			return RoutingRule{}, ErrRoutingOrderInvalid
		}
		*field.target = value
	}
	if p.MatchPattern != nil && rule.MatchPattern == "" {
		rule.MatchPattern = "*"
	}
	if p.TargetModel != nil && rule.TargetModel == "" {
		return RoutingRule{}, ErrRoutingOrderInvalid
	}
	if p.Priority != nil {
		if *p.Priority < 1 || *p.Priority > 10000 {
			return RoutingRule{}, ErrRoutingOrderInvalid
		}
		rule.Priority = *p.Priority
	}
	if p.MinComplexity != nil {
		rule.MinComplexity = *p.MinComplexity
	}
	if p.MaxComplexity != nil {
		rule.MaxComplexity = *p.MaxComplexity
	}
	if rule.MinComplexity < 0 || rule.MaxComplexity > 100 || rule.MinComplexity > rule.MaxComplexity || rule == before {
		return RoutingRule{}, ErrRoutingOrderInvalid
	}
	return rule, nil
}

// Compare the whole reviewed configuration while excluding all ordinary rule
// writers. The short transaction contains no upstream call or retry. The
// revision is a content comparison, not ABA detection or an idempotency token.
func (s *SQLStore) CommitRoutingRuleEdit(ctx context.Context, revision, id string, patch RoutingRulePatch, audit AdminAuditLog) (RoutingOrderSnapshot, error) {
	if audit.Action != "routing_rule.reviewed_update" {
		return RoutingOrderSnapshot{}, ErrRoutingOrderInvalid
	}
	var result RoutingOrderSnapshot
	err := s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		var err error
		if s.dialect == "postgres" {
			_, err = tx.ExecContext(ctx, `LOCK TABLE routing_rules IN SHARE ROW EXCLUSIVE MODE`)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE routing_rules SET priority = priority WHERE 0`)
		}
		if err != nil {
			return err
		}
		draft, err := s.routingRuleDraft(ctx, tx, revision, id, patch)
		if err != nil {
			return err
		}
		rule := draft.Rule
		changed, err := tx.ExecContext(ctx, s.bind(`UPDATE routing_rules SET priority = ?, match_pattern = ?, min_complexity = ?, max_complexity = ?, target_model = ?, target_provider = ?, note = ? WHERE id = ?`), rule.Priority, rule.MatchPattern, rule.MinComplexity, rule.MaxComplexity, rule.TargetModel, rule.TargetProvider, rule.Note, id)
		if err != nil {
			return err
		}
		count, err := changed.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrRoutingOrderConflict
		}
		result, err = s.routingOrderSnapshot(ctx, tx)
		if err == nil && result.Revision != draft.ResultRevision {
			return ErrRoutingOrderConflict
		}
		return err
	})
	if err != nil {
		return RoutingOrderSnapshot{}, err
	}
	return result, nil
}
