package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"
)

var ErrChangeSetRecoveryPending = errors.New("change set recovery must finish before deletion")

var errChangeSetAlreadyFinalized = errors.New("change set already finalized")

// CreateChangeSetAudited returns the persisted snapshot only after both the
// draft and its audit commit. No post-change hooks run within this transaction.
func (s *SQLStore) CreateChangeSetAudited(ctx context.Context, cs ChangeSet, audit AdminAuditLog) (ChangeSet, error) {
	if cs.ID == "" || cs.Status != "" && cs.Status != "draft" {
		return ChangeSet{}, errors.New("invalid change set draft")
	}
	var created ChangeSet
	err := s.changeSetAuditedTransaction(ctx, audit, func(tx *sql.Tx) error {
		var err error
		created, err = s.insertChangeSet(ctx, tx, cs)
		return err
	})
	if err != nil {
		return ChangeSet{}, err
	}
	return created, nil
}

// DeleteChangeSetAudited deletes only the current server snapshot and records
// the deletion atomically. It does not introduce client-side idempotency.
func (s *SQLStore) DeleteChangeSetAudited(ctx context.Context, cs ChangeSet, audit AdminAuditLog) error {
	if cs.ID == "" || cs.Status == "" || cs.UpdatedAt == "" {
		return errors.New("change set deletion snapshot is required")
	}
	if cs.Status == "apply_pending" || cs.Status == "rollback_pending" {
		return ErrChangeSetRecoveryPending
	}
	return s.changeSetAuditedTransaction(ctx, audit, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM change_sets WHERE id = ? AND status = ? AND updated_at = ?`), cs.ID, cs.Status, cs.UpdatedAt)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return fmt.Errorf("%w: deletion snapshot is no longer current", ErrChangeSetConflict)
		}
		return nil
	})
}

// TransitionChangeSetAudited moves a reviewed snapshot forward only if both its
// status and revision still match. The review and audit either commit together
// or neither persists. This does not apply settings or reload any process.
func (s *SQLStore) TransitionChangeSetAudited(ctx context.Context, next ChangeSet, expectedStatus string, audit AdminAuditLog) (ChangeSet, error) {
	if next.ID == "" || next.UpdatedAt == "" ||
		!(expectedStatus == "draft" && next.Status == "pending" || expectedStatus == "pending" && next.Status == "approved") {
		return ChangeSet{}, errors.New("invalid reviewed change set transition")
	}
	expectedRevision := next.UpdatedAt
	next.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	err := s.changeSetAuditedTransaction(ctx, audit, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.bind(`UPDATE change_sets SET status = ?, reviewer = ?, note = ?, updated_at = ?
			WHERE id = ? AND status = ? AND updated_at = ?`), next.Status, next.Reviewer, next.Note, next.UpdatedAt,
			next.ID, expectedStatus, expectedRevision)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return fmt.Errorf("%w: reviewed snapshot is no longer current", ErrChangeSetConflict)
		}
		return nil
	})
	if err != nil {
		return ChangeSet{}, err
	}
	return next, nil
}

// StageChangeSetSettingsAudited commits settings, their history, the resumable
// marker and a persistence audit together. Runtime reload remains outside SQL.
func (s *SQLStore) StageChangeSetSettingsAudited(ctx context.Context, cs ChangeSet, expectedStatus, changedBy, reason string, settings []AdminSetting, audit AdminAuditLog) (ChangeSet, error) {
	if cs.ID == "" || cs.UpdatedAt == "" ||
		!(expectedStatus == "approved" && cs.Status == "apply_pending" || expectedStatus == "applied" && cs.Status == "rollback_pending") {
		return ChangeSet{}, errors.New("invalid change set persistence transition")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err := s.changeSetAuditedTransaction(ctx, audit, func(tx *sql.Tx) error {
		return s.stageChangeSetSettingsTx(ctx, tx, cs, expectedStatus, changedBy, reason, settings, now)
	})
	if err != nil {
		return ChangeSet{}, err
	}
	cs.UpdatedAt = now
	return cs, nil
}

// FinalizeChangeSetAudited commits the completion marker and completion audit
// together after this process reloaded its runtime. Concurrent finalizers emit
// one audit; an already-finalized row returns its current snapshot without a
// second event or hook. It never rewrites settings or setting history.
func (s *SQLStore) FinalizeChangeSetAudited(ctx context.Context, cs ChangeSet, pendingStatus, finalStatus string, audit AdminAuditLog) (ChangeSet, bool, error) {
	if cs.ID == "" || cs.UpdatedAt == "" || cs.Status != pendingStatus ||
		!(pendingStatus == "apply_pending" && finalStatus == "applied" || pendingStatus == "rollback_pending" && finalStatus == "rolled_back") {
		return ChangeSet{}, false, errors.New("invalid change set completion transition")
	}
	next := cs
	next.Status, next.UpdatedAt = finalStatus, time.Now().UTC().Format(time.RFC3339Nano)
	err := s.changeSetAuditedTransaction(ctx, audit, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.bind(`UPDATE change_sets SET status = ?, updated_at = ?
			WHERE id = ? AND status = ? AND updated_at = ?`), next.Status, next.UpdatedAt, cs.ID, pendingStatus, cs.UpdatedAt)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 1 {
			return nil
		}
		current, err := scanChangeSet(tx.QueryRowContext(ctx, s.bind(`SELECT id, title, description, status, items, prior,
			canary_scope, created_by, reviewer, note, created_at, updated_at, applied_at FROM change_sets WHERE id = ?`), cs.ID))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrChangeSetConflict
			}
			return err
		}
		if current.Status != finalStatus {
			return ErrChangeSetConflict
		}
		next = current
		return errChangeSetAlreadyFinalized
	})
	if errors.Is(err, errChangeSetAlreadyFinalized) {
		return next, false, nil
	}
	if err != nil {
		return ChangeSet{}, false, err
	}
	return next, true, nil
}

func (s *SQLStore) changeSetAuditedTransaction(ctx context.Context, audit AdminAuditLog, mutate func(*sql.Tx) error) error {
	if audit.ID == "" || audit.Action == "" {
		return errors.New("change set audit identity and action are required")
	}
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
	if err := mutate(tx); err != nil {
		return err
	}
	if err := s.insertAdminAudit(ctx, tx, audit); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		// Match runtime flag transactions: SQLite may retain an SQL transaction
		// after database/sql has marked a failed COMMIT's Tx done.
		_ = tx.Rollback()
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, cleanupErr := conn.ExecContext(cleanupCtx, "ROLLBACK"); cleanupErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		return err
	}
	return nil
}
