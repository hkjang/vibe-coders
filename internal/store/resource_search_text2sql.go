package store

import (
	"context"
	"strings"
)

// SearchText2SQLSchemaMetadata matches the overview's global-or-team visibility.
// A scoped empty or unknown team sees global schemas only; disabled schemas remain
// visible to operators. Neither context, allowlists nor team values are selected.
func (s *SQLStore) SearchText2SQLSchemaMetadata(ctx context.Context, query string, limit int, teams []string, scoped bool) ([]ResourceMetadata, bool, error) {
	var scope *resourceMetadataScope
	if scoped {
		terms := []string{"COALESCE(team, '') = ''"}
		values := []any{}
		seen := map[string]bool{}
		for _, team := range teams {
			if team == "" || strings.TrimSpace(team) != team || seen[team] {
				continue
			}
			seen[team] = true
			terms = append(terms, "team = ?")
			values = append(values, team)
		}
		scope = &resourceMetadataScope{expression: strings.Join(terms, " OR "), values: values}
	}
	return s.searchResourceMetadata(ctx, "text2sql_schemas", "name", "name", query, limit, scope)
}
