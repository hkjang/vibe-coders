package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

var ErrInvalidAuthTeamQuery = errors.New("invalid registered team page query")

type AuthTeamSort struct {
	Field string
	Desc  bool
}

type AuthTeamQuery struct {
	Search    string
	ScopeTeam *string // Existing authenticated identifier; no new input-size policy.
	Sort      []AuthTeamSort
	Limit     int
	Offset    int
}

type AuthTeamPage struct {
	Teams  []AuthTeam `json:"auth_teams"`
	Total  int64      `json:"total"`
	Limit  int        `json:"limit"`
	Offset int        `json:"offset"`
}

func authTeamOrder(sorts []AuthTeamSort, prefix string) (string, error) {
	if len(sorts) > 3 {
		return "", ErrInvalidAuthTeamQuery
	}
	if len(sorts) == 0 {
		sorts = []AuthTeamSort{{Field: "name"}}
	}
	allowed := map[string]bool{"id": true, "name": true, "created_at": true, "updated_at": true}
	seen := map[string]bool{}
	parts := make([]string, 0, len(sorts)+1)
	for _, sort := range sorts {
		if !allowed[sort.Field] || seen[sort.Field] {
			return "", ErrInvalidAuthTeamQuery
		}
		seen[sort.Field] = true
		direction := " ASC"
		if sort.Desc {
			direction = " DESC"
		}
		parts = append(parts, prefix+sort.Field+direction)
	}
	if !seen["id"] {
		parts = append(parts, prefix+"id ASC")
	}
	return strings.Join(parts, ", "), nil
}

// ListAuthTeamPage counts and pages the same authorized snapshot. Existing
// identifiers and names remain intact; limits apply to new search inputs/rows.
func (s *SQLStore) ListAuthTeamPage(ctx context.Context, query AuthTeamQuery) (AuthTeamPage, error) {
	page := AuthTeamPage{Teams: []AuthTeam{}, Limit: query.Limit, Offset: query.Offset}
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1_000_000 ||
		!validAuthAccountText(query.Search, 800) || utf8.RuneCountInString(query.Search) > 200 {
		return page, ErrInvalidAuthTeamQuery
	}
	order, err := authTeamOrder(query.Sort, "")
	if err != nil {
		return page, err
	}
	outerOrder, _ := authTeamOrder(query.Sort, "p.")
	where := []string{"1 = 1"}
	args := []any{}
	if query.ScopeTeam != nil {
		where = append(where, "id = ?")
		args = append(args, *query.ScopeTeam)
	}
	if query.Search != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Search) + "%"
		where = append(where, "(LOWER(id) LIKE LOWER(?) ESCAPE '!' OR LOWER(name) LIKE LOWER(?) ESCAPE '!')")
		args = append(args, pattern, pattern)
	}
	args = append(args, query.Limit, query.Offset)
	statement := `WITH filtered AS (
		SELECT id, name, created_at, updated_at FROM teams WHERE ` + strings.Join(where, " AND ") + `
	), page AS (
		SELECT * FROM filtered ORDER BY ` + order + ` LIMIT ? OFFSET ?
	)
	SELECT c.total, p.id, p.name, p.created_at, p.updated_at
	FROM (SELECT COUNT(*) AS total FROM filtered) c LEFT JOIN page p ON 1 = 1
	ORDER BY ` + outerOrder
	rows, err := s.db.QueryContext(ctx, s.bind(statement), args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, createdAt, updatedAt sql.NullString
		if err := rows.Scan(&page.Total, &id, &name, &createdAt, &updatedAt); err != nil {
			return page, err
		}
		if id.Valid {
			page.Teams = append(page.Teams, AuthTeam{ID: id.String, Name: name.String,
				CreatedAt: parseOptionalTime(createdAt.String), UpdatedAt: parseOptionalTime(updatedAt.String)})
		}
	}
	return page, rows.Err()
}
