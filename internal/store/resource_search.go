package store

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// ResourceMetadata deliberately excludes definitions, instructions, credentials,
// owners and configuration. This is navigation, not a second business API.
type ResourceMetadata struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// SearchResourceMetadata performs literal substring matching on stored names.
// Identifiers are fixed below, never supplied by the caller. LIMIT bounds returned
// rows, not scanned rows: substring search may scan the small configuration table.
// Callers must provide a deadline. It does not contact model/MCP upstreams.
func (s *SQLStore) SearchResourceMetadata(ctx context.Context, kind, query string, limit int) ([]ResourceMetadata, bool, error) {
	var table, id, title string
	switch kind {
	case "provider":
		table, id, title = "provider_configs", "name", "name"
	case "workflow":
		table, id, title = "workflows", "id", "name"
	case "app":
		table, id, title = "work_apps", "id", "title"
	case "skill":
		table, id, title = "skills", "name", "name"
	default:
		return nil, false, errors.New("unsupported resource kind")
	}
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 128 || limit < 1 || limit > 50 {
		return nil, false, errors.New("invalid resource search bounds")
	}
	// Escape SQL LIKE metacharacters; search text is never SQL syntax.
	pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(query)) + "%"
	byteLength := func(column string) string { return "LENGTH(CAST(" + column + " AS BLOB))" }
	if s.dialect == "postgres" {
		byteLength = func(column string) string { return "OCTET_LENGTH(" + column + ")" }
	}
	statement := "SELECT " + id + ", " + title + " FROM " + table +
		" WHERE LENGTH(" + id + ") BETWEEN 1 AND 512 AND LENGTH(" + title + ") BETWEEN 1 AND 256" +
		// Byte bounds also cover SQLite legacy text containing embedded NUL, for
		// which character LENGTH alone does not bound the value returned to Go.
		" AND " + byteLength(id) + " <= 2048 AND " + byteLength(title) + " <= 1024" +
		" AND LOWER(" + title + ") LIKE ? ESCAPE '!' ORDER BY " + title + ", " + id + " LIMIT ?"
	rows, err := s.db.QueryContext(ctx, s.bind(statement), pattern, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]ResourceMetadata, 0, limit)
	for rows.Next() {
		var item ResourceMetadata
		if err := rows.Scan(&item.ID, &item.Title); err != nil {
			return nil, false, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(items) > limit
	if more {
		items = items[:limit]
	}
	return items, more, nil
}
