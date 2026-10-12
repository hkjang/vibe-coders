package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type adminAuditExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// SaveRuntimeFlagAudited commits one flag and its admin audit together. No
// external side effects or automatic retries run while holding the transaction.
// A statement, validation or commit error returns no success snapshot.
func (s *SQLStore) SaveRuntimeFlagAudited(ctx context.Context, flag RuntimeFlag, audit AdminAuditLog) (RuntimeFlag, error) {
	if audit.ID == "" || audit.Action == "" {
		return RuntimeFlag{}, errors.New("invalid runtime flag audit")
	}
	if flag.UpdatedAt.IsZero() {
		flag.UpdatedAt = time.Now().UTC()
	}
	if audit.CreatedAt.IsZero() {
		audit.CreatedAt = flag.UpdatedAt
	}
	snapshot, err := s.saveRuntimeFlagBatch(ctx, []RuntimeFlag{flag}, []string{flag.Key}, func(flags map[string]RuntimeFlag) error {
		written, found := flags[flag.Key]
		if !found || written.Value != flag.Value || written.Note != flag.Note || written.UpdatedBy != flag.UpdatedBy || !written.UpdatedAt.Equal(flag.UpdatedAt) {
			return errors.New("runtime flag audit snapshot mismatch")
		}
		return nil
	}, &audit)
	if err != nil {
		return RuntimeFlag{}, err
	}
	return snapshot[flag.Key], nil
}
