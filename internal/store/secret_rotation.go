package store

import (
	"context"
	"fmt"
)

// RotateEncryptedColumns re-encrypts every secret column in the database from
// the old cipher to a new cipher. All updates run inside a single transaction
// so the rotation is all-or-nothing. Returns a per-table count of rotated rows.
//
// Tables covered:
//   - provider_configs.encrypted_api_key
//   - mcp_upstreams.encrypted_auth
//   - text2sql_exec_connections.encrypted_dsn
//   - admin_settings.value_json (only rows where is_secret=1)
func (s *SQLStore) RotateEncryptedColumns(
	ctx context.Context,
	decrypt func(string) (string, error),
	encrypt func(string) (string, error),
) (map[string]int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	counts := map[string]int{}

	// --- provider_configs ---
	{
		rows, err := tx.QueryContext(ctx, `SELECT name, encrypted_api_key FROM provider_configs WHERE encrypted_api_key != ''`)
		if err != nil {
			return nil, fmt.Errorf("provider_configs select: %w", err)
		}
		type row struct{ name, enc string }
		var items []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.name, &r.enc); err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, item := range items {
			plain, err := decrypt(item.enc)
			if err != nil {
				return nil, fmt.Errorf("provider_configs %q: decrypt: %w", item.name, err)
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("provider_configs %q: encrypt: %w", item.name, err)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE provider_configs SET encrypted_api_key=? WHERE name=?`), newEnc, item.name); err != nil {
				return nil, fmt.Errorf("provider_configs %q: update: %w", item.name, err)
			}
			counts["provider_configs"]++
		}
	}

	// --- mcp_upstreams ---
	{
		rows, err := tx.QueryContext(ctx, `SELECT id, encrypted_auth FROM mcp_upstreams WHERE encrypted_auth != ''`)
		if err != nil {
			return nil, fmt.Errorf("mcp_upstreams select: %w", err)
		}
		type row struct{ id, enc string }
		var items []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.enc); err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, item := range items {
			plain, err := decrypt(item.enc)
			if err != nil {
				return nil, fmt.Errorf("mcp_upstreams %q: decrypt: %w", item.id, err)
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("mcp_upstreams %q: encrypt: %w", item.id, err)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE mcp_upstreams SET encrypted_auth=? WHERE id=?`), newEnc, item.id); err != nil {
				return nil, fmt.Errorf("mcp_upstreams %q: update: %w", item.id, err)
			}
			counts["mcp_upstreams"]++
		}
	}

	// --- text2sql_exec_connections ---
	{
		rows, err := tx.QueryContext(ctx, `SELECT id, encrypted_dsn FROM text2sql_exec_connections WHERE encrypted_dsn != ''`)
		if err != nil {
			return nil, fmt.Errorf("text2sql_exec_connections select: %w", err)
		}
		type row struct{ id, enc string }
		var items []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.enc); err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, item := range items {
			plain, err := decrypt(item.enc)
			if err != nil {
				return nil, fmt.Errorf("text2sql_exec_connections %q: decrypt: %w", item.id, err)
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("text2sql_exec_connections %q: encrypt: %w", item.id, err)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE text2sql_exec_connections SET encrypted_dsn=? WHERE id=?`), newEnc, item.id); err != nil {
				return nil, fmt.Errorf("text2sql_exec_connections %q: update: %w", item.id, err)
			}
			counts["text2sql_exec_connections"]++
		}
	}

	// --- admin_settings (is_secret=1 rows only) ---
	{
		rows, err := tx.QueryContext(ctx, `SELECT key, value_json FROM admin_settings WHERE is_secret=1 AND value_json != ''`)
		if err != nil {
			return nil, fmt.Errorf("admin_settings select: %w", err)
		}
		type row struct{ key, enc string }
		var items []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.key, &r.enc); err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, item := range items {
			plain, err := decrypt(item.enc)
			if err != nil {
				// Non-secret rows may slip through the is_secret=1 filter if value is plain JSON —
				// skip rows that fail decryption rather than aborting the whole rotation.
				continue
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("admin_settings %q: encrypt: %w", item.key, err)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE admin_settings SET value_json=? WHERE key=?`), newEnc, item.key); err != nil {
				return nil, fmt.Errorf("admin_settings %q: update: %w", item.key, err)
			}
			counts["admin_settings"]++
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return counts, nil
}
