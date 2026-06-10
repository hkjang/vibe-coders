package store

import (
	"context"
	"database/sql"
	"time"
)

// MCPUpstream is a registered upstream MCP server that the gateway aggregates and
// routes to. EncryptedAuth holds an optional bearer token (encrypted at rest).
type MCPUpstream struct {
	ID            string `json:"id"`   // slug, also the tool namespace prefix
	Name          string `json:"name"` // display name
	URL           string `json:"url"`  // Streamable HTTP MCP endpoint
	EncryptedAuth string `json:"-"`
	HasAuth       bool   `json:"has_auth"`
	Enabled       bool   `json:"enabled"`
	CreatedAt     string `json:"created_at"`
}

func (s *SQLStore) ListMCPUpstreams(ctx context.Context) ([]MCPUpstream, error) {
	return s.queryMCPUpstreams(ctx, "")
}

func (s *SQLStore) ActiveMCPUpstreams(ctx context.Context) ([]MCPUpstream, error) {
	return s.queryMCPUpstreams(ctx, "WHERE enabled = 1")
}

func (s *SQLStore) queryMCPUpstreams(ctx context.Context, where string) ([]MCPUpstream, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, url, COALESCE(encrypted_auth, ''), enabled, created_at
		FROM mcp_upstreams `+where+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPUpstream{}
	for rows.Next() {
		var u MCPUpstream
		var enabled int
		if err := rows.Scan(&u.ID, &u.Name, &u.URL, &u.EncryptedAuth, &enabled, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.Enabled = enabled == 1
		u.HasAuth = u.EncryptedAuth != ""
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetMCPUpstream(ctx context.Context, id string) (MCPUpstream, bool, error) {
	var u MCPUpstream
	var enabled int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, name, url, COALESCE(encrypted_auth, ''), enabled, created_at
		FROM mcp_upstreams WHERE id = ?`), id).Scan(&u.ID, &u.Name, &u.URL, &u.EncryptedAuth, &enabled, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return MCPUpstream{}, false, nil
	}
	if err != nil {
		return MCPUpstream{}, false, err
	}
	u.Enabled = enabled == 1
	u.HasAuth = u.EncryptedAuth != ""
	return u, true, nil
}

func (s *SQLStore) UpsertMCPUpstream(ctx context.Context, u MCPUpstream) error {
	if u.CreatedAt == "" {
		u.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	enabled := 0
	if u.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO mcp_upstreams (id, name, url, encrypted_auth, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, encrypted_auth = excluded.encrypted_auth, enabled = excluded.enabled`),
		u.ID, u.Name, u.URL, u.EncryptedAuth, enabled, u.CreatedAt)
	return err
}

func (s *SQLStore) DeleteMCPUpstream(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM mcp_upstreams WHERE id = ?`), id)
	return err
}
