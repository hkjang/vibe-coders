package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const MaxRoutingOrderRules = 1000

var (
	ErrRoutingOrderConflict = errors.New("routing configuration changed")
	ErrRoutingOrderInvalid  = errors.New("invalid routing order")
	ErrRoutingOrderLimit    = errors.New("routing order exceeds supported bounds")
)

// Revision covers all stored configuration, including raw creation timestamps.
// It is a content comparison, not an authorization or idempotency token.
type RoutingOrderSnapshot struct {
	Rules         []RoutingRule `json:"rules"`
	Revision      string        `json:"revision"`
	AmbiguousTies bool          `json:"ambiguous_ties"`
}

type routingOrderQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type routingOrderStored struct {
	RoutingRule
	RawCreatedAt string `json:"raw_created_at"`
}

// GetRoutingOrderSnapshot preserves the legacy SQL order. Equal priority and
// equal creation time have no defined tiebreaker in the existing router; report
// that ambiguity rather than inventing a new live-routing order.
func (s *SQLStore) GetRoutingOrderSnapshot(ctx context.Context) (RoutingOrderSnapshot, error) {
	return s.routingOrderSnapshot(ctx, s.db)
}

func (s *SQLStore) routingOrderSnapshot(ctx context.Context, db routingOrderQueryer) (RoutingOrderSnapshot, error) {
	rows, err := db.QueryContext(ctx, s.bind(`SELECT id, enabled, priority, match_pattern, min_complexity, max_complexity,
		target_model, COALESCE(target_provider, ''), COALESCE(note, ''), created_at
		FROM routing_rules ORDER BY priority ASC, created_at ASC LIMIT ?`), MaxRoutingOrderRules+1)
	if err != nil {
		return RoutingOrderSnapshot{}, err
	}
	defer rows.Close()
	stored := []routingOrderStored{}
	result := RoutingOrderSnapshot{Rules: []RoutingRule{}}
	seenTies := map[string]bool{}
	for rows.Next() {
		var item routingOrderStored
		var enabled int
		if err := rows.Scan(&item.ID, &enabled, &item.Priority, &item.MatchPattern, &item.MinComplexity, &item.MaxComplexity,
			&item.TargetModel, &item.TargetProvider, &item.Note, &item.RawCreatedAt); err != nil {
			return RoutingOrderSnapshot{}, err
		}
		if !validRoutingOrderID(item.ID) || len(stored) == MaxRoutingOrderRules {
			return RoutingOrderSnapshot{}, ErrRoutingOrderLimit
		}
		item.Enabled = enabled == 1
		item.CreatedAt, _ = time.Parse(time.RFC3339Nano, item.RawCreatedAt)
		tie := fmt.Sprintf("%d:%s", item.Priority, item.RawCreatedAt)
		if seenTies[tie] {
			result.AmbiguousTies = true
		}
		seenTies[tie] = true
		stored = append(stored, item)
		result.Rules = append(result.Rules, item.RoutingRule)
	}
	if err := rows.Err(); err != nil {
		return RoutingOrderSnapshot{}, err
	}
	// A backend's unspecified ordering of legacy ties must not change the token.
	sort.Slice(stored, func(i, j int) bool { return stored[i].ID < stored[j].ID })
	encoded, err := json.Marshal(stored)
	if err != nil {
		return RoutingOrderSnapshot{}, err
	}
	digest := sha256.Sum256(encoded)
	result.Revision = hex.EncodeToString(digest[:])
	return result, nil
}

func validRoutingOrderID(id string) bool {
	if !utf8.ValidString(id) || len(id) == 0 || len(id) > 2048 || utf8.RuneCountInString(id) > 512 {
		return false
	}
	for _, r := range id {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// ProposedRoutingOrder validates an exact permutation of the complete snapshot.
// Priorities are explicitly normalized to 1..N; all other fields are preserved.
func ProposedRoutingOrder(before RoutingOrderSnapshot, ids []string) ([]RoutingRule, error) {
	if len(ids) < 2 || len(ids) > MaxRoutingOrderRules || len(ids) != len(before.Rules) {
		return nil, ErrRoutingOrderInvalid
	}
	byID := make(map[string]RoutingRule, len(before.Rules))
	for _, rule := range before.Rules {
		byID[rule.ID] = rule
	}
	ordered := make([]RoutingRule, 0, len(ids))
	for i, id := range ids {
		if !validRoutingOrderID(id) {
			return nil, ErrRoutingOrderInvalid
		}
		rule, ok := byID[id]
		if !ok {
			return nil, ErrRoutingOrderInvalid
		}
		delete(byID, id)
		rule.Priority = i + 1
		ordered = append(ordered, rule)
	}
	return ordered, nil
}

// ReorderRoutingRules commits every priority and its audit together. Existing
// single-rule writers participate through their normal database write locks.
// Ordinary SELECTs remain available in PostgreSQL. No upstream call or retry
// occurs while holding the lock; callers must bound the operation's context.
func (s *SQLStore) ReorderRoutingRules(ctx context.Context, revision string, ids []string, audit AdminAuditLog) (RoutingOrderSnapshot, error) {
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != sha256.Size || len(ids) < 2 || len(ids) > MaxRoutingOrderRules || audit.Action != "routing_rule.reorder" {
		return RoutingOrderSnapshot{}, ErrRoutingOrderInvalid
	}
	var result RoutingOrderSnapshot
	err = s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		if s.dialect == "postgres" {
			_, err = tx.ExecContext(ctx, `LOCK TABLE routing_rules IN SHARE ROW EXCLUSIVE MODE`)
		} else {
			// Obtain SQLite's write reservation before any read, even when empty.
			_, err = tx.ExecContext(ctx, `UPDATE routing_rules SET priority = priority WHERE 0`)
		}
		if err != nil {
			return err
		}
		before, err := s.routingOrderSnapshot(ctx, tx)
		if err != nil {
			return err
		}
		if before.Revision != revision {
			return ErrRoutingOrderConflict
		}
		ordered, err := ProposedRoutingOrder(before, ids)
		if err != nil {
			return err
		}
		var statement strings.Builder
		statement.WriteString("UPDATE routing_rules SET priority = CASE id")
		args := make([]any, 0, len(ordered))
		for i, rule := range ordered {
			fmt.Fprintf(&statement, " WHEN ? THEN %d", i+1)
			args = append(args, rule.ID)
		}
		statement.WriteString(" ELSE priority END")
		changed, err := tx.ExecContext(ctx, s.bind(statement.String()), args...)
		if err != nil {
			return err
		}
		count, err := changed.RowsAffected()
		if err != nil {
			return err
		}
		if count != int64(len(ordered)) {
			return ErrRoutingOrderConflict
		}
		result, err = s.routingOrderSnapshot(ctx, tx)
		return err
	})
	if err != nil {
		return RoutingOrderSnapshot{}, err
	}
	return result, nil
}
