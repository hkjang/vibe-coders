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
	case "mcp_upstream":
		table, id, title = "mcp_upstreams", "id", "name"
	case "policy":
		table, id, title = "policies", "id", "name"
	default:
		return nil, false, errors.New("unsupported resource kind")
	}
	return s.searchResourceMetadata(ctx, table, id, title, query, limit, nil)
}

// SearchAuthTeamMetadata uses the same exact authenticated team-ID boundary as
// ListAuthTeamPage. Keep it separate from the unscoped resource-kind API so a
// caller cannot accidentally request team metadata without considering scope.
func (s *SQLStore) SearchAuthTeamMetadata(ctx context.Context, query string, limit int, scopeTeam *string) ([]ResourceMetadata, bool, error) {
	var scope *resourceMetadataScope
	if scopeTeam != nil {
		scope = &resourceMetadataScope{expression: "id", value: *scopeTeam}
	}
	return s.searchResourceMetadata(ctx, "teams", "id", "name", query, limit, scope)
}

// SearchAuthAccountMetadata selects names and IDs only. Primary-team selection
// matches ListAuthAccountPage and PrimaryTeamForUser, including unassigned users.
// This cannot be requested through the generic unscoped resource-kind API.
func (s *SQLStore) SearchAuthAccountMetadata(ctx context.Context, query string, limit int, scopeTeam *string) ([]ResourceMetadata, bool, error) {
	var scope *resourceMetadataScope
	if scopeTeam != nil {
		scope = &resourceMetadataScope{
			expression: "COALESCE((SELECT m.team_id FROM user_team_memberships m WHERE m.user_id = u.id ORDER BY m.created_at ASC LIMIT 1), '')",
			value:      *scopeTeam,
		}
	}
	return s.searchResourceMetadata(ctx, "users u", "u.id", "u.name", query, limit, scope)
}

// expression is trusted SQL supplied only by the fixed callers above; the
// authenticated scope value is always bound, including empty or legacy IDs.
type resourceMetadataScope struct {
	expression string
	value      string
}

// All SQL identifiers come from the fixed sources above, never request input.
func (s *SQLStore) searchResourceMetadata(ctx context.Context, table, id, title, query string, limit int, scope *resourceMetadataScope) ([]ResourceMetadata, bool, error) {
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 128 || limit < 1 || limit > 50 {
		return nil, false, errors.New("invalid resource search bounds")
	}
	// Escape SQL LIKE metacharacters; search text is never SQL syntax.
	pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query) + "%"
	byteLength := func(column string) string { return "LENGTH(CAST(" + column + " AS BLOB))" }
	if s.dialect == "postgres" {
		byteLength = func(column string) string { return "OCTET_LENGTH(" + column + ")" }
	}
	statement := "SELECT " + id + ", " + title + " FROM " + table +
		" WHERE LENGTH(" + id + ") BETWEEN 1 AND 512 AND LENGTH(" + title + ") BETWEEN 1 AND 256" +
		// Byte bounds also cover SQLite legacy text containing embedded NUL, for
		// which character LENGTH alone does not bound the value returned to Go.
		" AND " + byteLength(id) + " <= 2048 AND " + byteLength(title) + " <= 1024" +
		" AND " + s.metadataLowerSQL(title) + " LIKE " + s.metadataLowerSQL("?") + " ESCAPE '!'"
	args := []any{pattern}
	if scope != nil {
		statement += " AND " + scope.expression + " = ?"
		args = append(args, scope.value)
	}
	statement += " ORDER BY " + title + ", " + id + " LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, s.bind(statement), args...)
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
