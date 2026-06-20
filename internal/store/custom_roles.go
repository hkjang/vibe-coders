package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// CustomRole is an admin-defined role overlaying the built-in role→scope map. It lets an
// operator introduce a new role (e.g. billing_admin, auditor) without a code change.
type CustomRole struct {
	Role        string   `json:"role"`
	Description string   `json:"description"`
	Scopes      []string `json:"scopes"`
	DefaultHome string   `json:"default_home"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

// ListCustomRoles returns all admin-defined roles, name-ordered.
func (s *SQLStore) ListCustomRoles(ctx context.Context) ([]CustomRole, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT role, COALESCE(description,''), COALESCE(scopes,''), COALESCE(default_home,''), created_at, updated_at
		FROM custom_roles ORDER BY role`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CustomRole{}
	for rows.Next() {
		var c CustomRole
		var scopesRaw string
		if err := rows.Scan(&c.Role, &c.Description, &scopesRaw, &c.DefaultHome, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Scopes = parseTags(scopesRaw)
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetCustomRole returns one admin-defined role by name.
func (s *SQLStore) GetCustomRole(ctx context.Context, role string) (CustomRole, bool, error) {
	var c CustomRole
	var scopesRaw string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT role, COALESCE(description,''), COALESCE(scopes,''), COALESCE(default_home,''), created_at, updated_at
		FROM custom_roles WHERE role = ?`), role).
		Scan(&c.Role, &c.Description, &scopesRaw, &c.DefaultHome, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return CustomRole{}, false, nil
	}
	if err != nil {
		return CustomRole{}, false, err
	}
	c.Scopes = parseTags(scopesRaw)
	return c, true, nil
}

// UpsertCustomRole inserts or updates an admin-defined role, preserving created_at.
func (s *SQLStore) UpsertCustomRole(ctx context.Context, c CustomRole) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var createdAt string
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT created_at FROM custom_roles WHERE role = ?`), c.Role)
	switch err := row.Scan(&createdAt); {
	case errors.Is(err, sql.ErrNoRows):
		createdAt = now
	case err != nil:
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO custom_roles (role, description, scopes, default_home, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(role) DO UPDATE SET
			description = excluded.description, scopes = excluded.scopes,
			default_home = excluded.default_home, updated_at = excluded.updated_at`),
		c.Role, c.Description, joinTags(c.Scopes), c.DefaultHome, createdAt, now)
	return err
}

// DeleteCustomRole removes an admin-defined role.
func (s *SQLStore) DeleteCustomRole(ctx context.Context, role string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM custom_roles WHERE role = ?`), role)
	return err
}
