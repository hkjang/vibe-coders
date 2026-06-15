package store

import (
	"context"
	"time"
)

// Text2SQLFeatureFlag is a runtime on/off toggle for an optional Text2SQL feature,
// managed from the admin UI/API so an operator can enable cost- or behavior-affecting
// features (e.g. self-challenge review, gateway memory) without a redeploy.
type Text2SQLFeatureFlag struct {
	Name      string `json:"name"`
	Enabled   bool   `json:"enabled"`
	UpdatedAt string `json:"updated_at"`
}

// ListText2SQLFeatureFlags returns all persisted feature-flag states.
func (s *SQLStore) ListText2SQLFeatureFlags(ctx context.Context) ([]Text2SQLFeatureFlag, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, enabled, COALESCE(updated_at,'') FROM text2sql_feature_flags`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLFeatureFlag{}
	for rows.Next() {
		var f Text2SQLFeatureFlag
		var enabled int
		if err := rows.Scan(&f.Name, &enabled, &f.UpdatedAt); err != nil {
			return nil, err
		}
		f.Enabled = enabled == 1
		out = append(out, f)
	}
	return out, rows.Err()
}

// SetText2SQLFeatureFlag persists a feature toggle state.
func (s *SQLStore) SetText2SQLFeatureFlag(ctx context.Context, name string, enabled bool) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_feature_flags (name, enabled, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`),
		name, boolInt(enabled), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

// RecentText2SQLSQLByAPIKey returns the generated SQL of an API key's recent valid,
// non-shadow Text2SQL queries — used by gateway memory to learn which tables a user
// tends to query.
func (s *SQLStore) RecentText2SQLSQLByAPIKey(ctx context.Context, apiKeyID string, limit int) ([]string, error) {
	if apiKeyID == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(generated_sql,'') FROM text2sql_query_logs
		WHERE api_key_id = ? AND valid = 1 AND COALESCE(mode,'') <> 'shadow' AND COALESCE(generated_sql,'') <> ''
		ORDER BY created_at DESC LIMIT ?`), apiKeyID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var sql string
		if err := rows.Scan(&sql); err != nil {
			return nil, err
		}
		out = append(out, sql)
	}
	return out, rows.Err()
}

// Text2SQLFeatureFlagMap returns the flags as a name→enabled map for in-memory caching.
func (s *SQLStore) Text2SQLFeatureFlagMap(ctx context.Context) (map[string]bool, error) {
	flags, err := s.ListText2SQLFeatureFlags(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]bool, len(flags))
	for _, f := range flags {
		m[f.Name] = f.Enabled
	}
	return m, nil
}
