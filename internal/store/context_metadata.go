package store

import (
	"context"
	"database/sql"
	"fmt"
)

// ContextMetadata deliberately excludes content and identifiers used for writes.
type ContextMetadata struct {
	Key, Name, LastUsedAt, UpdatedAt string
	Enabled                          bool
	TokenEstimate, UseCount          int
}

// ContextMetadataPage reads a bounded projection of the existing registry. The
// count and page share one read snapshot; content is never selected.
func (s *SQLStore) ContextMetadataPage(ctx context.Context, enabled *bool, limit, offset int) ([]ContextMetadata, int, error) {
	if limit < 1 || limit > 100 || offset < 0 || offset > 1000000 {
		return nil, 0, fmt.Errorf("invalid context page")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	where, args := "", []any{}
	if enabled != nil {
		where, args = " WHERE enabled = ?", []any{boolInt(*enabled)}
	}
	var total int
	if err := tx.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM context_registry"+where), args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT key, name, enabled, token_estimate, use_count,
		COALESCE(last_used_at, ''), updated_at FROM context_registry`+where+` ORDER BY key ASC LIMIT ? OFFSET ?`), append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	items := []ContextMetadata{}
	for rows.Next() {
		var item ContextMetadata
		var active int
		if err := rows.Scan(&item.Key, &item.Name, &active, &item.TokenEstimate, &item.UseCount, &item.LastUsedAt, &item.UpdatedAt); err != nil {
			rows.Close()
			return nil, 0, err
		}
		item.Enabled = active == 1
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}
