package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

var (
	ErrRoutingRuleNotFound     = errors.New("routing rule not found")
	ErrRoutingRuleInvalidRange = errors.New("invalid routing rule complexity range")
)

// RoutingRulePatch carries already-normalized, individually validated inputs.
// Nil fields retain the database value at the write, not an earlier snapshot.
type RoutingRulePatch struct {
	Enabled        *bool
	Priority       *int
	MatchPattern   *string
	MinComplexity  *int
	MaxComplexity  *int
	TargetModel    *string
	TargetProvider *string
	Note           *string
}

func (s *SQLStore) ListRoutingRules(ctx context.Context) ([]RoutingRule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, enabled, priority, match_pattern, min_complexity, max_complexity,
		target_model, COALESCE(target_provider, ''), COALESCE(note, ''), created_at
		FROM routing_rules ORDER BY priority ASC, created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []RoutingRule{}
	for rows.Next() {
		var r RoutingRule
		var enabled int
		var createdAt string
		if err := rows.Scan(&r.ID, &enabled, &r.Priority, &r.MatchPattern, &r.MinComplexity, &r.MaxComplexity,
			&r.TargetModel, &r.TargetProvider, &r.Note, &createdAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			r.CreatedAt = parsed
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// ActiveRoutingRules returns enabled rules ordered by priority (lowest first).
func (s *SQLStore) ActiveRoutingRules(ctx context.Context) ([]RoutingRule, error) {
	all, err := s.ListRoutingRules(ctx)
	if err != nil {
		return nil, err
	}
	active := make([]RoutingRule, 0, len(all))
	for _, r := range all {
		if r.Enabled {
			active = append(active, r)
		}
	}
	sort.SliceStable(active, func(i, j int) bool { return active[i].Priority < active[j].Priority })
	return active, nil
}

func (s *SQLStore) UpsertRoutingRule(ctx context.Context, r RoutingRule) error {
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	query := s.bind(`INSERT INTO routing_rules (id, enabled, priority, match_pattern, min_complexity, max_complexity, target_model, target_provider, note, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			enabled = excluded.enabled,
			priority = excluded.priority,
			match_pattern = excluded.match_pattern,
			min_complexity = excluded.min_complexity,
			max_complexity = excluded.max_complexity,
			target_model = excluded.target_model,
			target_provider = excluded.target_provider,
			note = excluded.note`)
	_, err := s.db.ExecContext(ctx, query, r.ID, boolInt(r.Enabled), r.Priority, r.MatchPattern, r.MinComplexity, r.MaxComplexity,
		r.TargetModel, r.TargetProvider, r.Note, formatTime(r.CreatedAt))
	return err
}

// PatchRoutingRule only updates an existing ID. The range predicate and values
// are evaluated by the same statement; omitted fields cannot overwrite another
// writer's changes. Explicit fields remain last-writer-wins, not compare-and-swap.
func (s *SQLStore) PatchRoutingRule(ctx context.Context, id string, p RoutingRulePatch) (RoutingRule, error) {
	var enabled any
	if p.Enabled != nil {
		enabled = boolInt(*p.Enabled)
	}
	query := s.bind(`UPDATE routing_rules SET
		enabled = COALESCE(?, enabled), priority = COALESCE(?, priority),
		match_pattern = COALESCE(?, match_pattern),
		min_complexity = COALESCE(?, min_complexity), max_complexity = COALESCE(?, max_complexity),
		target_model = COALESCE(?, target_model), target_provider = COALESCE(?, target_provider),
		note = COALESCE(?, note)
		WHERE id = ? AND COALESCE(?, min_complexity) >= 0
		AND COALESCE(?, max_complexity) <= 100
		AND COALESCE(?, min_complexity) <= COALESCE(?, max_complexity)
		RETURNING id, enabled, priority, match_pattern, min_complexity, max_complexity,
		target_model, COALESCE(target_provider, ''), COALESCE(note, ''), created_at`)
	var result RoutingRule
	var storedEnabled int
	var createdAt string
	err := s.db.QueryRowContext(ctx, query, enabled, p.Priority, p.MatchPattern,
		p.MinComplexity, p.MaxComplexity, p.TargetModel, p.TargetProvider, p.Note,
		id, p.MinComplexity, p.MaxComplexity, p.MinComplexity, p.MaxComplexity).Scan(
		&result.ID, &storedEnabled, &result.Priority, &result.MatchPattern,
		&result.MinComplexity, &result.MaxComplexity, &result.TargetModel,
		&result.TargetProvider, &result.Note, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		// The UPDATE changed no row. This narrow follow-up classifies the current
		// existence only: a concurrent delete may turn an invalid-range outcome
		// into not-found. It is not a snapshot/CAS diagnosis of the prior attempt.
		var exists int
		lookupErr := s.db.QueryRowContext(ctx, s.bind(`SELECT 1 FROM routing_rules WHERE id = ?`), id).Scan(&exists)
		if errors.Is(lookupErr, sql.ErrNoRows) {
			return RoutingRule{}, ErrRoutingRuleNotFound
		}
		if lookupErr != nil {
			return RoutingRule{}, lookupErr
		}
		return RoutingRule{}, ErrRoutingRuleInvalidRange
	}
	if err != nil {
		return RoutingRule{}, err
	}
	result.Enabled = storedEnabled == 1
	result.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return result, nil
}

func (s *SQLStore) DeleteRoutingRule(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM routing_rules WHERE id = ?`), id)
	return err
}
