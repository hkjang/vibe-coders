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

var ErrInvalidWorkflowQuery = errors.New("invalid workflow page query")

type WorkflowSort struct {
	Field string
	Desc  bool
}

type WorkflowQuery struct {
	Search  string
	Enabled *bool
	Sort    []WorkflowSort
	Limit   int
	Offset  int
}

// WorkflowMetadata deliberately leaves step definitions to an independent detail
// read. AllowedTeams is an execution policy, not an admin-list visibility scope.
type WorkflowMetadata struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	AllowedTeams string `json:"allowed_teams"`
	Enabled      bool   `json:"enabled"`
	CreatedBy    string `json:"created_by"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	StepCount    int    `json:"step_count"`
}

type WorkflowPage struct {
	Workflows []WorkflowMetadata `json:"workflows"`
	Total     int64              `json:"total"`
	Limit     int                `json:"limit"`
	Offset    int                `json:"offset"`
	Summary   WorkflowSummary    `json:"summary"`
}

type WorkflowSummary struct {
	Total   int64 `json:"total"`
	Enabled int64 `json:"enabled"`
}

func ValidWorkflowDetailID(id string) bool {
	return id != "" && utf8.ValidString(id) && len(id) <= 4096 && strings.IndexFunc(id, unicode.IsControl) < 0
}

func workflowPageOrder(sorts []WorkflowSort, prefix string) (string, error) {
	if len(sorts) > 3 {
		return "", ErrInvalidWorkflowQuery
	}
	if len(sorts) == 0 {
		sorts = []WorkflowSort{{Field: "created_at", Desc: true}}
	}
	allowed := map[string]bool{"id": true, "name": true, "allowed_teams": true, "enabled": true, "created_at": true, "updated_at": true}
	seen := map[string]bool{}
	parts := make([]string, 0, len(sorts)+1)
	for _, item := range sorts {
		if !allowed[item.Field] || seen[item.Field] {
			return "", ErrInvalidWorkflowQuery
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

// ListWorkflowPage counts, summarizes and pages in one database snapshot. Only
// the selected page's step JSON reaches Go; no unbounded definition list is read.
// Authorization remains the existing administrator API's responsibility.
func (s *SQLStore) ListWorkflowPage(ctx context.Context, query WorkflowQuery) (WorkflowPage, error) {
	page := WorkflowPage{Workflows: []WorkflowMetadata{}, Limit: query.Limit, Offset: query.Offset}
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1_000_000 ||
		!validAuthAccountText(query.Search, 800) || utf8.RuneCountInString(query.Search) > 200 {
		return page, ErrInvalidWorkflowQuery
	}
	order, err := workflowPageOrder(query.Sort, "")
	if err != nil {
		return page, err
	}
	outerOrder, _ := workflowPageOrder(query.Sort, "p.")
	where := []string{"1 = 1"}
	args := []any{}
	if query.Enabled != nil {
		if *query.Enabled {
			where = append(where, "enabled <> 0")
		} else {
			where = append(where, "enabled = 0")
		}
	}
	if query.Search != "" {
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Search) + "%"
		matches := []string{}
		for _, field := range []string{"id", "name", "description", "allowed_teams"} {
			matches = append(matches, s.metadataLowerSQL(field)+" LIKE "+s.metadataLowerSQL("?")+" ESCAPE '!'")
			args = append(args, pattern)
		}
		where = append(where, "("+strings.Join(matches, " OR ")+")")
	}
	args = append(args, query.Limit, query.Offset)
	statement := `WITH filtered AS (
		SELECT id, name, description, allowed_teams, enabled, created_by, created_at, updated_at
		FROM workflows WHERE ` + strings.Join(where, " AND ") + `
	), page AS (
		SELECT * FROM filtered ORDER BY ` + order + ` LIMIT ? OFFSET ?
	)
	SELECT c.total, s.total, s.enabled,
		p.id, p.name, p.description, w.steps, p.allowed_teams, p.enabled, p.created_by, p.created_at, p.updated_at
	FROM (SELECT COUNT(*) AS total FROM filtered) c
	CROSS JOIN (SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN enabled <> 0 THEN 1 ELSE 0 END), 0) AS enabled FROM workflows) s
	LEFT JOIN page p ON 1 = 1
	LEFT JOIN workflows w ON w.id = p.id ORDER BY ` + outerOrder
	rows, err := s.db.QueryContext(ctx, s.bind(statement), args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, description, steps, teams, createdBy, createdAt, updatedAt sql.NullString
		var enabled sql.NullInt64
		if err := rows.Scan(&page.Total, &page.Summary.Total, &page.Summary.Enabled,
			&id, &name, &description, &steps, &teams, &enabled, &createdBy, &createdAt, &updatedAt); err != nil {
			return page, err
		}
		if id.Valid {
			var parsed []WorkflowStep
			// Match scanWorkflow's behavior for old malformed step definitions.
			_ = json.Unmarshal([]byte(steps.String), &parsed)
			page.Workflows = append(page.Workflows, WorkflowMetadata{
				ID: id.String, Name: name.String, Description: description.String,
				AllowedTeams: teams.String, Enabled: enabled.Int64 != 0, CreatedBy: createdBy.String,
				CreatedAt: createdAt.String, UpdatedAt: updatedAt.String, StepCount: len(parsed),
			})
		}
	}
	return page, rows.Err()
}
