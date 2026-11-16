package store

import (
	"context"
	"database/sql"
	"fmt"
)

// PromptProductMetadata excludes bodies, descriptions, authors and mutation IDs.
// Source counts are the snapshot saved at registration; DistinctKeys counts API
// keys, despite the historical distinct_users storage column name.
type PromptProductMetadata struct {
	Name, Category, TemplateState, LastUsedAt, CreatedAt string
	SourceRequests, DistinctKeys                         *int64
	UseCount                                             *int64
}

func (s *SQLStore) PromptProductMetadataPage(ctx context.Context, state string, limit, offset int) ([]PromptProductMetadata, int, error) {
	where := ""
	switch state {
	case "all":
	case "enabled":
		where = " WHERE t.id IS NOT NULL AND t.enabled = 1"
	case "disabled":
		where = " WHERE t.id IS NOT NULL AND t.enabled <> 1"
	case "missing":
		where = " WHERE t.id IS NULL"
	default:
		return nil, 0, fmt.Errorf("invalid product state")
	}
	if limit < 1 || limit > 100 || offset < 0 || offset > 1000000 {
		return nil, 0, fmt.Errorf("invalid product page")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	join := " FROM prompt_products p LEFT JOIN prompt_templates t ON t.id = p.template_id"
	var total int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*)"+join+where).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT p.name, p.category,
		CASE WHEN TRIM(COALESCE(p.source_fingerprint, '')) = '' THEN NULL ELSE p.request_count END,
		CASE WHEN TRIM(COALESCE(p.source_fingerprint, '')) = '' THEN NULL ELSE p.distinct_users END,
		CASE WHEN t.id IS NULL THEN 'missing' WHEN t.enabled = 1 THEN 'enabled' ELSE 'disabled' END,
		t.use_count, COALESCE(t.last_used_at, ''), p.created_at`+join+where+` ORDER BY p.created_at DESC, p.id ASC LIMIT ? OFFSET ?`), limit, offset)
	if err != nil {
		return nil, 0, err
	}
	items := []PromptProductMetadata{}
	for rows.Next() {
		var item PromptProductMetadata
		var count, source, keys sql.NullInt64
		if err := rows.Scan(&item.Name, &item.Category, &source, &keys, &item.TemplateState, &count, &item.LastUsedAt, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, 0, err
		}
		if count.Valid {
			item.UseCount = &count.Int64
		}
		if source.Valid {
			item.SourceRequests = &source.Int64
		}
		if keys.Valid {
			item.DistinctKeys = &keys.Int64
		}
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
