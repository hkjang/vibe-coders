package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sort"
	"strings"
	"time"
)

type runtimeFlagQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// GetRuntimeFlagSnapshot reads the requested flags in one database snapshot.
func (s *SQLStore) GetRuntimeFlagSnapshot(ctx context.Context, keys []string) (map[string]RuntimeFlag, error) {
	return s.runtimeFlagSnapshot(ctx, s.db, keys)
}

// SaveRuntimeFlagBatch applies only the supplied keys atomically and returns a
// snapshot read within that transaction. A read/write/commit failure returns no
// success snapshot. Omitted keys are never rewritten from a cached configuration.
func (s *SQLStore) SaveRuntimeFlagBatch(ctx context.Context, updates []RuntimeFlag, snapshotKeys []string) (map[string]RuntimeFlag, error) {
	return s.SaveRuntimeFlagBatchValidated(ctx, updates, snapshotKeys, nil)
}

// SaveRuntimeFlagBatchValidated validates the prospective snapshot inside the
// transaction, after applying updates but before committing them. Validation
// failure rolls back every update and returns no success snapshot. The validator
// must not mutate the snapshot or perform external side effects.
func (s *SQLStore) SaveRuntimeFlagBatchValidated(ctx context.Context, updates []RuntimeFlag, snapshotKeys []string, validate func(map[string]RuntimeFlag) error) (map[string]RuntimeFlag, error) {
	allowed := make(map[string]bool, len(snapshotKeys))
	for _, key := range snapshotKeys {
		allowed[key] = true
	}
	seen := make(map[string]bool, len(updates))
	for _, update := range updates {
		if update.Key == "" || !allowed[update.Key] || seen[update.Key] {
			return nil, errors.New("invalid runtime flag batch keys")
		}
		seen[update.Key] = true
	}
	ordered := append([]RuntimeFlag(nil), updates...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Key < ordered[j].Key })
	// Retain the connection until cleanup: some SQLite driver COMMIT failures
	// leave the SQL transaction open after database/sql has marked its Tx done.
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	for _, flag := range ordered {
		if flag.UpdatedAt.IsZero() {
			flag.UpdatedAt = now
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO runtime_flags (key, value, updated_at, updated_by, note)
			VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			updated_at = excluded.updated_at, updated_by = excluded.updated_by, note = excluded.note`),
			flag.Key, flag.Value, formatTime(flag.UpdatedAt), flag.UpdatedBy, flag.Note); err != nil {
			return nil, err
		}
	}
	snapshot, err := s.runtimeFlagSnapshot(ctx, tx, snapshotKeys)
	if err != nil {
		return nil, err
	}
	if validate != nil {
		if err := validate(snapshot); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, cleanupErr := conn.ExecContext(cleanupCtx, "ROLLBACK"); cleanupErr != nil {
			// Close alone returns a connection to the pool. Discard it instead
			// when we cannot confirm the failed transaction was cleaned up.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		return nil, err
	}
	return snapshot, nil
}

func (s *SQLStore) runtimeFlagSnapshot(ctx context.Context, queryer runtimeFlagQueryer, keys []string) (map[string]RuntimeFlag, error) {
	result := make(map[string]RuntimeFlag, len(keys))
	if len(keys) == 0 {
		return result, nil
	}
	args := make([]any, len(keys))
	for i, key := range keys {
		args[i] = key
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",")
	rows, err := queryer.QueryContext(ctx, s.bind(`SELECT key, value, updated_at, COALESCE(updated_by, ''), COALESCE(note, '') FROM runtime_flags WHERE key IN (`+placeholders+`)`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var flag RuntimeFlag
		var updatedAt string
		if err := rows.Scan(&flag.Key, &flag.Value, &updatedAt, &flag.UpdatedBy, &flag.Note); err != nil {
			return nil, err
		}
		flag.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
		result[flag.Key] = flag
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
