package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrInvalidAuthAccountQuery = errors.New("invalid auth account page query")

// AuthAccount contains only public account metadata, never password hashes.
type AuthAccount struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	Status    string    `json:"status"`
	TeamID    string    `json:"team_id"`
	TeamName  string    `json:"team_name"`
	CreatedAt time.Time `json:"created_at"`
}

type AuthAccountSort struct {
	Field string
	Desc  bool
}

type AuthAccountQuery struct {
	Search string
	Role   string
	Status string
	// A non-nil empty team means unassigned. ScopeTeam is server authority;
	// Team is an additional user filter and can never broaden that authority.
	ScopeTeam *string
	Team      *string
	Sort      []AuthAccountSort
	Limit     int
	Offset    int
}

type AuthAccountPage struct {
	Accounts []AuthAccount `json:"accounts"`
	Total    int64         `json:"total"`
	Limit    int           `json:"limit"`
	Offset   int           `json:"offset"`
}

func validAuthAccountText(value string, maximum int) bool {
	return utf8.ValidString(value) && len(value) <= maximum && strings.IndexFunc(value, func(r rune) bool {
		return r < 32 || r == 127
	}) < 0
}

func authAccountOrder(sorts []AuthAccountSort, prefix string) (string, error) {
	if len(sorts) > 3 {
		return "", ErrInvalidAuthAccountQuery
	}
	if len(sorts) == 0 {
		sorts = []AuthAccountSort{{Field: "created_at", Desc: true}}
	}
	allowed := map[string]bool{"id": true, "email": true, "name": true, "role": true, "status": true, "team_id": true, "team_name": true, "created_at": true}
	seen := map[string]bool{}
	parts := make([]string, 0, len(sorts)+1)
	for _, sort := range sorts {
		if !allowed[sort.Field] || seen[sort.Field] {
			return "", ErrInvalidAuthAccountQuery
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

// ListAuthAccountPage scopes before counting and paging. A single statement
// returns the count even for an empty/out-of-range page, using one DB snapshot.
// Primary team selection intentionally matches PrimaryTeamForUser.
func (s *SQLStore) ListAuthAccountPage(ctx context.Context, query AuthAccountQuery) (AuthAccountPage, error) {
	page := AuthAccountPage{Accounts: []AuthAccount{}, Limit: query.Limit, Offset: query.Offset}
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1_000_000 ||
		!validAuthAccountText(query.Search, 800) || utf8.RuneCountInString(query.Search) > 200 ||
		!validAuthAccountText(query.Role, 256) || !validAuthAccountText(query.Status, 256) {
		return page, ErrInvalidAuthAccountQuery
	}
	order, err := authAccountOrder(query.Sort, "")
	if err != nil {
		return page, err
	}
	outerOrder, _ := authAccountOrder(query.Sort, "p.")
	where := []string{"1 = 1"}
	args := []any{}
	// Authenticated team scope is an existing identifier, not a search input.
	// Legacy teams may have long IDs or separators; parameter binding preserves
	// their exact authority without applying new URL-input restrictions.
	if query.ScopeTeam != nil {
		where = append(where, "team_id = ?")
		args = append(args, *query.ScopeTeam)
	}
	if query.Team != nil {
		if !validAuthAccountText(*query.Team, 256) {
			return page, ErrInvalidAuthAccountQuery
		}
		where = append(where, "team_id = ?")
		args = append(args, *query.Team)
	}
	for _, filter := range []struct{ field, value string }{{"role", query.Role}, {"status", query.Status}} {
		if filter.value != "" {
			where = append(where, filter.field+" = ?")
			args = append(args, filter.value)
		}
	}
	if query.Search != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Search) + "%"
		fields := []string{"id", "email", "name", "role", "team_id", "team_name"}
		matches := make([]string, 0, len(fields))
		for _, field := range fields {
			matches = append(matches, "LOWER("+field+") LIKE LOWER(?) ESCAPE '!'")
			args = append(args, pattern)
		}
		where = append(where, "("+strings.Join(matches, " OR ")+")")
	}
	args = append(args, query.Limit, query.Offset)
	statement := `WITH accounts AS (
		SELECT u.id, u.email, COALESCE(u.name, '') AS name, u.role, u.status, u.created_at,
			COALESCE((SELECT m.team_id FROM user_team_memberships m WHERE m.user_id = u.id ORDER BY m.created_at ASC LIMIT 1), '') AS team_id
		FROM users u
	), named AS (
		SELECT a.*, COALESCE(t.name, '') AS team_name FROM accounts a LEFT JOIN teams t ON t.id = a.team_id
	), filtered AS (
		SELECT * FROM named WHERE ` + strings.Join(where, " AND ") + `
	), page AS (
		SELECT * FROM filtered ORDER BY ` + order + ` LIMIT ? OFFSET ?
	)
	SELECT c.total, p.id, p.email, p.name, p.role, p.status, p.team_id, p.team_name, p.created_at
	FROM (SELECT COUNT(*) AS total FROM filtered) c LEFT JOIN page p ON 1 = 1
	ORDER BY ` + outerOrder
	rows, err := s.db.QueryContext(ctx, s.bind(statement), args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, email, name, role, status, teamID, teamName, createdAt sql.NullString
		if err := rows.Scan(&page.Total, &id, &email, &name, &role, &status, &teamID, &teamName, &createdAt); err != nil {
			return page, err
		}
		if id.Valid {
			page.Accounts = append(page.Accounts, AuthAccount{ID: id.String, Email: email.String, Name: name.String,
				Role: role.String, Status: status.String, TeamID: teamID.String, TeamName: teamName.String, CreatedAt: parseOptionalTime(createdAt.String)})
		}
	}
	return page, rows.Err()
}
