package store

import (
	"context"
	"time"
)

// SnoozeAction defers an action-queue card type for a user until the given time.
// Re-snoozing the same type overwrites the prior deadline.
func (s *SQLStore) SnoozeAction(ctx context.Context, userID, actionType string, until time.Time) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO me_action_snoozes (user_id, action_type, snoozed_until, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, action_type) DO UPDATE SET snoozed_until = excluded.snoozed_until, created_at = excluded.created_at`),
		userID, actionType, until.UTC().Format(time.RFC3339Nano), now)
	return err
}

// SnoozedActions returns the set of action types still snoozed for a user as of `now`.
func (s *SQLStore) SnoozedActions(ctx context.Context, userID string, now time.Time) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT action_type FROM me_action_snoozes
		WHERE user_id = ? AND snoozed_until > ?`), userID, now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out[t] = true
	}
	return out, rows.Err()
}
