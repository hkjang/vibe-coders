package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"time"
)

// withAdminAuditTransaction commits a short database mutation and audit together.
// No external calls or retries belong inside mutate.
func (s *SQLStore) withAdminAuditTransaction(ctx context.Context, audit AdminAuditLog, mutate func(*sql.Tx) error) error {
	if audit.ID == "" || audit.Action == "" {
		return errors.New("admin audit identity and action are required")
	}
	return s.withPreparedAdminAuditTransaction(ctx, func(tx *sql.Tx) (AdminAuditLog, error) {
		return audit, mutate(tx)
	})
}

// withPreparedAdminAuditTransaction lets a reviewed batch derive its audit from
// the same snapshot used for validation and changes. No network calls or retries.
func (s *SQLStore) withPreparedAdminAuditTransaction(ctx context.Context, prepare func(*sql.Tx) (AdminAuditLog, error)) error {
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
	audit, err := prepare(tx)
	if err != nil {
		return err
	}
	if audit.ID == "" || audit.Action == "" {
		return errors.New("admin audit identity and action are required")
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
