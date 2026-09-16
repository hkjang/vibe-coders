package store

import (
	"context"
	"strings"
	"time"

	"vibe-coders/internal/mail"
)

// mailDeliveryRetention bounds the delivery log. It is an operator's "did it
// go?" record, not an audit trail, and a quarter is longer than anyone asks.
const mailDeliveryRetention = 90 * 24 * time.Hour

// RecordMailDelivery writes one queued attempt. Old rows are pruned on the way
// in so the table stays bounded without another worker.
func (s *SQLStore) RecordMailDelivery(ctx context.Context, delivery mail.Delivery) error {
	_, _ = s.db.ExecContext(ctx, s.bind(`DELETE FROM mail_deliveries WHERE created_at < ?`), formatTime(delivery.CreatedAt.Add(-mailDeliveryRetention)))
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO mail_deliveries (id, event, recipient, subject, subject_id, actor_id, status, attempts, error_message, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		delivery.ID, delivery.Event, delivery.Recipient, delivery.Subject, delivery.SubjectID, delivery.ActorID,
		mail.StatusQueued, 0, "", formatTime(delivery.CreatedAt), formatTime(delivery.CreatedAt))
	return err
}

// CompleteMailDelivery records how an attempt ended.
func (s *SQLStore) CompleteMailDelivery(ctx context.Context, id, status string, attempts int, errorMessage string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE mail_deliveries SET status = ?, attempts = ?, error_message = ?, updated_at = ? WHERE id = ?`),
		status, attempts, errorMessage, formatTime(at), id)
	return err
}

// MailDeliveryAttemptedSince reports whether the same news already went (or
// tried to go) to the same person recently, which is how "once per key per
// day" is kept without a second table.
func (s *SQLStore) MailDeliveryAttemptedSince(ctx context.Context, event, recipient, subjectID string, since time.Time) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM mail_deliveries WHERE event = ? AND recipient = ? AND subject_id = ? AND created_at >= ?`),
		event, recipient, subjectID, formatTime(since)).Scan(&count)
	return count > 0, err
}

// ListMailDeliveries returns the newest attempts first, optionally one status.
func (s *SQLStore) ListMailDeliveries(ctx context.Context, status string, limit int) ([]mail.Delivery, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	query := `SELECT id, event, recipient, subject, subject_id, actor_id, status, attempts, error_message, created_at, updated_at FROM mail_deliveries`
	args := []any{}
	if status = strings.TrimSpace(status); status != "" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deliveries := []mail.Delivery{}
	for rows.Next() {
		var item mail.Delivery
		var createdAt, updatedAt string
		if err := rows.Scan(&item.ID, &item.Event, &item.Recipient, &item.Subject, &item.SubjectID, &item.ActorID,
			&item.Status, &item.Attempts, &item.ErrorMessage, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		item.CreatedAt, _ = parseStoredTime(createdAt)
		item.UpdatedAt, _ = parseStoredTime(updatedAt)
		deliveries = append(deliveries, item)
	}
	return deliveries, rows.Err()
}

// MailDeliveryCounts is the status breakdown of the whole log.
func (s *SQLStore) MailDeliveryCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM mail_deliveries GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		counts[status] = count
	}
	return counts, rows.Err()
}

// LookupUserEmails resolves account ids to addresses through the users table the
// gateway already keeps — mail borrows this rather than owning a second list.
// Ids that are already addresses are matched by email as well, and only active
// accounts are returned: a disabled user should not keep receiving mail.
func (s *SQLStore) LookupUserEmails(ctx context.Context, ids []string) (map[string]string, error) {
	emails := make(map[string]string, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		user, found, err := s.AuthUserByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if !found && strings.Contains(id, "@") {
			user, found, err = s.AuthUserByEmail(ctx, id)
			if err != nil {
				return nil, err
			}
		}
		if !found || !strings.EqualFold(strings.TrimSpace(user.Status), "active") || strings.TrimSpace(user.Email) == "" {
			continue
		}
		emails[id] = strings.TrimSpace(user.Email)
	}
	return emails, nil
}
