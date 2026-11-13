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
