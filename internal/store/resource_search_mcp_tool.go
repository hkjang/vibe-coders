package store

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// MCPToolMetadata identifies an observed tool by both server and tool name.
// It deliberately carries no schema, arguments, results, URLs or credentials.
type MCPToolMetadata struct {
	ServerLabel string
	ToolName    string
}

// SearchMCPToolMetadata searches the same observed catalog as MCPCatalog.
// It never performs upstream discovery. LIMIT bounds returned metadata; literal
// substring matching can scan the catalog, so callers must supply a deadline.
func (s *SQLStore) SearchMCPToolMetadata(ctx context.Context, query string, limit int) ([]MCPToolMetadata, bool, error) {
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 128 || limit < 1 || limit > 50 {
		return nil, false, errors.New("invalid tool search bounds")
	}
	pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query) + "%"
	bytes := func(column string) string { return "LENGTH(CAST(" + column + " AS BLOB))" }
	if s.dialect == "postgres" {
		bytes = func(column string) string { return "OCTET_LENGTH(" + column + ")" }
	}
	statement := `SELECT server_label, tool_name FROM mcp_tool_catalog
		WHERE is_mcp = 1 AND LENGTH(server_label) BETWEEN 1 AND 512
		AND LENGTH(tool_name) BETWEEN 1 AND 256 AND ` + bytes("server_label") + ` <= 2048
		AND ` + bytes("tool_name") + ` <= 1024 AND ` + s.metadataLowerSQL("tool_name") +
		` LIKE ` + s.metadataLowerSQL("?") + ` ESCAPE '!' ORDER BY tool_name, server_label LIMIT ?`
	rows, err := s.db.QueryContext(ctx, s.bind(statement), pattern, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]MCPToolMetadata, 0, limit)
	for rows.Next() {
		var item MCPToolMetadata
		if err := rows.Scan(&item.ServerLabel, &item.ToolName); err != nil {
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
