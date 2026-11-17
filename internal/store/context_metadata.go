package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ContextMetadata deliberately excludes content and identifiers used for writes.
type ContextMetadata struct {
	Key, Name, LastUsedAt, UpdatedAt string
	Enabled                          bool
	TokenEstimate, UseCount          int
}

var ErrInvalidContextMetadataQuery = errors.New("invalid context metadata query")

type ContextMetadataQuery struct {
	Enabled       *bool
	Search, Sort  string
	Limit, Offset int
}

// ContextMetadataPage preserves the original key-ordered metadata view.
func (s *SQLStore) ContextMetadataPage(ctx context.Context, enabled *bool, limit, offset int) ([]ContextMetadata, int, error) {
	return s.SearchContextMetadataPage(ctx, ContextMetadataQuery{Enabled: enabled, Limit: limit, Offset: offset})
}

func contextMetadataOrder(raw string) (string, error) {
	if raw == "" {
		return "key ASC", nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 3 {
		return "", ErrInvalidContextMetadataQuery
	}
	seen := map[string]bool{}
	order := []string{}
	for _, part := range parts {
		fields := strings.Split(part, ":")
		if len(fields) != 2 || (fields[1] != "asc" && fields[1] != "desc") || seen[fields[0]] {
			return "", ErrInvalidContextMetadataQuery
		}
		field := fields[0]
		switch field {
		case "name", "key", "enabled":
		case "use_count", "token_estimate":
			// Historic invalid counts display as unknown and sort last in either direction.
			order = append(order, "CASE WHEN "+field+" >= 0 THEN 0 ELSE 1 END ASC")
			field = "CASE WHEN " + field + " >= 0 THEN " + field + " ELSE NULL END"
		default:
			return "", ErrInvalidContextMetadataQuery
		}
		seen[fields[0]] = true
		order = append(order, field+" "+strings.ToUpper(fields[1]))
	}
	if !seen["key"] {
		order = append(order, "key ASC")
	}
	return strings.Join(order, ", "), nil
}

// SearchContextMetadataPage counts and pages the same read snapshot. Search is
// bound literal text against name/key only; content and mutation IDs are never selected.
func (s *SQLStore) SearchContextMetadataPage(ctx context.Context, query ContextMetadataQuery) ([]ContextMetadata, int, error) {
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1000000 || !utf8.ValidString(query.Search) || utf8.RuneCountInString(query.Search) > 200 || strings.TrimSpace(query.Search) != query.Search || strings.IndexFunc(query.Search, unicode.IsControl) >= 0 {
		return nil, 0, ErrInvalidContextMetadataQuery
	}
	order, err := contextMetadataOrder(query.Sort)
	if err != nil {
		return nil, 0, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	clauses, args := []string{"1 = 1"}, []any{}
	if query.Enabled != nil {
		clauses = append(clauses, "enabled = ?")
		args = append(args, boolInt(*query.Enabled))
	}
	if query.Search != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Search) + "%"
		clauses = append(clauses, "("+s.metadataLowerSQL("key")+" LIKE "+s.metadataLowerSQL("?")+" ESCAPE '!' OR "+s.metadataLowerSQL("name")+" LIKE "+s.metadataLowerSQL("?")+" ESCAPE '!')")
		args = append(args, pattern, pattern)
	}
	where := " WHERE " + strings.Join(clauses, " AND ")
	var total int
	if err := tx.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM context_registry"+where), args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT key,name,enabled,token_estimate,use_count,COALESCE(last_used_at,''),updated_at FROM context_registry`+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`), append(args, query.Limit, query.Offset)...)
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
