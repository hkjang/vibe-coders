package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrInvalidWorkAppQuery = errors.New("invalid work app page query")

type WorkAppSort struct {
	Field string
	Desc  bool
}

type WorkAppQuery struct {
	Search string
	Status string
	Sort   []WorkAppSort
	Limit  int
	Offset int
}

// Components remain on the independent detail read. Team and role grants
// restrict end-user execution, not visibility in the existing administrator API.
type WorkAppMetadata struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Icon           string `json:"icon"`
	AllowedTeams   string `json:"allowed_teams"`
	AllowedRoles   string `json:"allowed_roles"`
	Status         string `json:"status"`
	Owner          string `json:"owner"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	ComponentCount int    `json:"component_count"`
}

type WorkAppSummary struct {
	Total    int64 `json:"total"`
	Active   int64 `json:"active"`
	Archived int64 `json:"archived"`
	Unscoped int64 `json:"unscoped"`
}

type WorkAppPage struct {
	Apps    []WorkAppMetadata `json:"apps"`
	Total   int64             `json:"total"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
	Summary WorkAppSummary    `json:"summary"`
}

func ValidWorkAppDetailID(id string) bool {
	return id != "" && utf8.ValidString(id) && len(id) <= 4096 && strings.IndexFunc(id, unicode.IsControl) < 0
}

func workAppPageOrder(sorts []WorkAppSort, prefix string) (string, error) {
	if len(sorts) > 3 {
		return "", ErrInvalidWorkAppQuery
	}
	if len(sorts) == 0 {
		sorts = []WorkAppSort{{Field: "title"}}
	}
	allowed := map[string]bool{"id": true, "title": true, "owner": true, "status": true, "created_at": true, "updated_at": true}
	seen := map[string]bool{}
	parts := make([]string, 0, len(sorts)+1)
	for _, item := range sorts {
		if !allowed[item.Field] || seen[item.Field] {
			return "", ErrInvalidWorkAppQuery
		}
		seen[item.Field] = true
		field := prefix + item.Field
		if item.Field == "created_at" || item.Field == "updated_at" {
			field = metadataTimestampOrderSQL(field)
		}
		direction := " ASC"
		if item.Desc {
			direction = " DESC"
		}
		parts = append(parts, field+direction)
	}
	if !seen["id"] {
		parts = append(parts, prefix+"id ASC")
	}
	return strings.Join(parts, ", "), nil
}

// ListWorkAppPage obtains the page, filtered count and global summary from one
// statement snapshot. Only this page's component JSON is read to count entries.
// It does not call the unbounded legacy list or change any stored definition.
func (s *SQLStore) ListWorkAppPage(ctx context.Context, query WorkAppQuery) (WorkAppPage, error) {
	page := WorkAppPage{Apps: []WorkAppMetadata{}, Limit: query.Limit, Offset: query.Offset}
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1_000_000 ||
		!validAuthAccountText(query.Search, 800) || utf8.RuneCountInString(query.Search) > 200 ||
		(query.Status != "" && query.Status != "active" && query.Status != "archived") {
		return page, ErrInvalidWorkAppQuery
	}
	order, err := workAppPageOrder(query.Sort, "")
	if err != nil {
		return page, err
	}
	outerOrder, _ := workAppPageOrder(query.Sort, "p.")
	where := []string{"1 = 1"}
	args := []any{}
	if query.Status != "" {
		where = append(where, "status = ?")
		args = append(args, query.Status)
	}
	if query.Search != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Search) + "%"
		matches := []string{}
		for _, field := range []string{"id", "title", "description", "owner", "allowed_teams", "allowed_roles"} {
			matches = append(matches, s.metadataLowerSQL(field)+" LIKE "+s.metadataLowerSQL("?")+" ESCAPE '!'")
			args = append(args, pattern)
		}
		where = append(where, "("+strings.Join(matches, " OR ")+")")
	}
	args = append(args, query.Limit, query.Offset)
	statement := `WITH filtered AS (
		SELECT id, title, description, icon, allowed_teams, allowed_roles, status, owner, created_at, updated_at
		FROM work_apps WHERE ` + strings.Join(where, " AND ") + `
	), page AS (
		SELECT * FROM filtered ORDER BY ` + order + ` LIMIT ? OFFSET ?
	)
	SELECT c.total, s.total, s.active, s.archived, s.unscoped,
		p.id, p.title, p.description, p.icon, a.components, p.allowed_teams, p.allowed_roles, p.status, p.owner, p.created_at, p.updated_at
	FROM (SELECT COUNT(*) AS total FROM filtered) c
	CROSS JOIN (SELECT COUNT(*) AS total,
		COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
		COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived,
		COALESCE(SUM(CASE WHEN allowed_teams = '' AND allowed_roles = '' THEN 1 ELSE 0 END), 0) AS unscoped FROM work_apps) s
	LEFT JOIN page p ON 1 = 1
	LEFT JOIN work_apps a ON a.id = p.id ORDER BY ` + outerOrder
	rows, err := s.db.QueryContext(ctx, s.bind(statement), args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, title, description, icon, components, teams, roles, status, owner, createdAt, updatedAt sql.NullString
		if err := rows.Scan(&page.Total, &page.Summary.Total, &page.Summary.Active, &page.Summary.Archived, &page.Summary.Unscoped,
			&id, &title, &description, &icon, &components, &teams, &roles, &status, &owner, &createdAt, &updatedAt); err != nil {
			return page, err
		}
		if id.Valid {
			var parsed []AppComponent
			// Preserve scanWorkApp's treatment of malformed legacy JSON.
			_ = json.Unmarshal([]byte(components.String), &parsed)
			page.Apps = append(page.Apps, WorkAppMetadata{
				ID: id.String, Title: title.String, Description: description.String, Icon: icon.String,
				AllowedTeams: teams.String, AllowedRoles: roles.String, Status: status.String,
				Owner: owner.String, CreatedAt: createdAt.String, UpdatedAt: updatedAt.String, ComponentCount: len(parsed),
			})
		}
	}
	return page, rows.Err()
}
