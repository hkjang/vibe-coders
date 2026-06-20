package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// AppComponent is one building block of an AI work app (a skill, prompt product, Text2SQL
// saved report, MCP tool, or recommended model), referenced by id/name.
type AppComponent struct {
	Kind  string `json:"kind"` // skill | prompt_product | text2sql_report | mcp_tool | model
	Ref   string `json:"ref"`
	Label string `json:"label"`
}

// WorkApp bundles components into a single user-facing "AI 업무 앱", gated by team/role.
type WorkApp struct {
	ID           string         `json:"id"`
	Title        string         `json:"title"`
	Description  string         `json:"description"`
	Icon         string         `json:"icon"`
	Components   []AppComponent `json:"components"`
	AllowedTeams string         `json:"allowed_teams"` // comma-separated; empty = any team
	AllowedRoles string         `json:"allowed_roles"` // comma-separated internal roles; empty = any role
	Status       string         `json:"status"`        // active | archived
	Owner        string         `json:"owner"`
	CreatedAt    string         `json:"created_at"`
	UpdatedAt    string         `json:"updated_at"`
}

func (s *SQLStore) CreateWorkApp(ctx context.Context, a WorkApp) error {
	if a.Status == "" {
		a.Status = "active"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	a.CreatedAt, a.UpdatedAt = now, now
	comp, _ := json.Marshal(a.Components)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO work_apps
		(id, title, description, icon, components, allowed_teams, allowed_roles, status, owner, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		a.ID, a.Title, a.Description, a.Icon, string(comp), a.AllowedTeams, a.AllowedRoles, a.Status, a.Owner, a.CreatedAt, a.UpdatedAt)
	return err
}

func (s *SQLStore) UpdateWorkApp(ctx context.Context, a WorkApp) error {
	comp, _ := json.Marshal(a.Components)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_apps SET title = ?, description = ?, icon = ?, components = ?,
		allowed_teams = ?, allowed_roles = ?, status = ?, updated_at = ? WHERE id = ?`),
		a.Title, a.Description, a.Icon, string(comp), a.AllowedTeams, a.AllowedRoles, a.Status,
		time.Now().UTC().Format(time.RFC3339Nano), a.ID)
	return err
}

func (s *SQLStore) DeleteWorkApp(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM work_apps WHERE id = ?`), id)
	return err
}

func scanWorkApp(sc interface{ Scan(...any) error }) (WorkApp, error) {
	var a WorkApp
	var comp string
	if err := sc.Scan(&a.ID, &a.Title, &a.Description, &a.Icon, &comp, &a.AllowedTeams, &a.AllowedRoles, &a.Status, &a.Owner, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return WorkApp{}, err
	}
	if strings.TrimSpace(comp) != "" {
		_ = json.Unmarshal([]byte(comp), &a.Components)
	}
	if a.Components == nil {
		a.Components = []AppComponent{}
	}
	return a, nil
}

func (s *SQLStore) ListWorkApps(ctx context.Context) ([]WorkApp, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, description, icon, components, allowed_teams, allowed_roles, status, owner, created_at, updated_at
		FROM work_apps ORDER BY title ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkApp{}
	for rows.Next() {
		a, err := scanWorkApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetWorkApp(ctx context.Context, id string) (WorkApp, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, title, description, icon, components, allowed_teams, allowed_roles, status, owner, created_at, updated_at
		FROM work_apps WHERE id = ?`), id)
	a, err := scanWorkApp(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkApp{}, false, nil
	}
	if err != nil {
		return WorkApp{}, false, err
	}
	return a, true, nil
}
