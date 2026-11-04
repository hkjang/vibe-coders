package store

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"
)

// RevokeAdminAPIKey compares the already-authorized snapshot and commits both
// audits with the key change. Hard deletion removes only the key row: request
// history, prior audit and durable rotation lineage remain intact.
func (s *SQLStore) RevokeAdminAPIKey(ctx context.Context, expected APIKeyRecord, hard bool, audit AdminAuditLog, event AuthEvent) error {
	action := "api_key.status"
	statement := "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE "
	params := []any{formatTime(time.Now().UTC())}
	if hard {
		action = "api_key.delete"
		statement = "DELETE FROM api_keys WHERE "
		params = nil
	}
	if audit.Action != action || event.EventType != "api_key_revoked" || event.APIKeyID != expected.ID || event.ID == "" || event.ActorUserID == "" {
		return errors.New("invalid key revocation audit")
	}
	return s.applyAdminAPIKeyChange(ctx, expected, statement, params, audit, &event)
}

// PatchAdminAPIKey never upserts an old record. A concurrent revoke/delete,
// ownership change or rotation therefore cannot be undone by a stale editor.
func (s *SQLStore) PatchAdminAPIKey(ctx context.Context, expected, updated APIKeyRecord, audit AdminAuditLog, event *AuthEvent, review ...string) error {
	if len(review) > 1 {
		return errors.New("ambiguous key review")
	}
	if updated.ID != expected.ID || audit.Action != "api_key.update" ||
		event != nil && (event.ID == "" || event.APIKeyID != expected.ID || event.EventType != "role_changed") {
		return errors.New("invalid key update audit")
	}
	return s.applyAdminAPIKeyChange(ctx, expected,
		"UPDATE api_keys SET name = ?, owner = ?, team = ?, role = ?, status = ?, scopes = ? WHERE ",
		[]any{updated.Name, updated.Owner, updated.Team, updated.Role, updated.Status, encodeStringList(updated.Scopes)}, audit, event, review...)
}

func (s *SQLStore) applyAdminAPIKeyChange(ctx context.Context, expected APIKeyRecord, statement string, params []any, audit AdminAuditLog, event *AuthEvent, review ...string) error {
	if expected.ID == "" || audit.ID == "" || audit.AdminID == "" {
		return errors.New("missing key snapshot or audit")
	}
	predicate, args := apiKeySnapshotPredicate(expected)
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.bind(statement+predicate), append(params, args...)...)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrAPIKeyConflict
	}
	if len(review) == 1 && review[0] != "" {
		// The UPDATE holds the key row lock. A new READ COMMITTED statement
		// now sees lineage committed by a rotation we may have waited behind,
		// even when expiry-capped grace left every original row field unchanged.
		// Use the authorized pre-edit values; this transaction's update is not
		// part of the browser snapshot. Any mismatch rolls it and audits back.
		current, err := s.apiKeyRevisionWithReader(ctx, tx, expected)
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare([]byte(current), []byte(review[0])) != 1 {
			return ErrAPIKeyConflict
		}
	}
	if err = s.insertAdminAudit(ctx, tx, audit); err != nil {
		return err
	}
	if event != nil {
		if err = s.insertAuditEvent(ctx, tx, *event); err != nil {
			return err
		}
	}
	return commitAPIKeyTransaction(ctx, conn, tx)
}
