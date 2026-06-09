package store

import (
	"context"
	"sort"
	"time"
)

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

func (s *SQLStore) DeleteRoutingRule(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM routing_rules WHERE id = ?`), id)
	return err
}
