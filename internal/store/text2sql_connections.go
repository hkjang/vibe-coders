package store

import (
	"context"
	"database/sql"
	"time"
)

// Text2SQLExecConnection is a named read-only database connection used as the
// execution target for Text2SQL profiles. The DSN is stored encrypted; callers
// that need to open a real *sql.DB must decrypt it first via the secrets service.
type Text2SQLExecConnection struct {
	ID           string `json:"id"`           // slug, e.g. "default", "analytics_db"
	Name         string `json:"name"`         // human-readable label
	Driver       string `json:"driver"`       // "sqlite" | "postgres"
	EncryptedDSN string `json:"-"`            // AES-GCM encrypted; never serialised to JSON
	Description  string `json:"description"`
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

func (s *SQLStore) ListText2SQLExecConnections(ctx context.Context) ([]Text2SQLExecConnection, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, driver, encrypted_dsn, COALESCE(description,''), enabled, created_at, updated_at
		 FROM text2sql_exec_connections ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Text2SQLExecConnection
	for rows.Next() {
		var c Text2SQLExecConnection
		var enabled int
		if err := rows.Scan(&c.ID, &c.Name, &c.Driver, &c.EncryptedDSN, &c.Description, &enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Enabled = enabled != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetText2SQLExecConnection(ctx context.Context, id string) (Text2SQLExecConnection, bool, error) {
	var c Text2SQLExecConnection
	var enabled int
	err := s.db.QueryRowContext(ctx, s.bind(
		`SELECT id, name, driver, encrypted_dsn, COALESCE(description,''), enabled, created_at, updated_at
		 FROM text2sql_exec_connections WHERE id = ?`), id).
		Scan(&c.ID, &c.Name, &c.Driver, &c.EncryptedDSN, &c.Description, &enabled, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	c.Enabled = enabled != 0
	return c, true, nil
}

func (s *SQLStore) UpsertText2SQLExecConnection(ctx context.Context, c Text2SQLExecConnection) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(
		`INSERT INTO text2sql_exec_connections (id, name, driver, encrypted_dsn, description, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name=excluded.name, driver=excluded.driver,
		 encrypted_dsn=CASE WHEN excluded.encrypted_dsn='' THEN text2sql_exec_connections.encrypted_dsn ELSE excluded.encrypted_dsn END,
		 description=excluded.description, enabled=excluded.enabled, updated_at=excluded.updated_at`),
		c.ID, c.Name, c.Driver, c.EncryptedDSN, c.Description, enabled, now, now)
	return err
}

func (s *SQLStore) DeleteText2SQLExecConnection(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_exec_connections WHERE id = ?`), id)
	return err
}
