package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// RotateEncryptedColumns re-encrypts every secret column in the database from
// the old cipher to a new cipher. All updates run inside a single transaction
// so the rotation is all-or-nothing. Returns a per-table count of rotated rows.
// Callers must quiesce other secret readers/writers for the database update and
// cipher switch; this transaction does not coordinate gateway instances.
//
// Tables covered:
//   - provider_configs.encrypted_api_key
//   - mcp_upstreams.encrypted_auth
//   - text2sql_exec_connections.encrypted_dsn
//   - admin_settings.value_json (only rows where is_secret=1)
//   - sso_provider_config.client_secret_enc
func (s *SQLStore) RotateEncryptedColumns(
	ctx context.Context,
	decrypt func(string) (string, error),
	encrypt func(string) (string, error),
) (map[string]int, error) {
	return s.rotateEncryptedColumns(ctx, decrypt, encrypt, nil)
}

// RotateEncryptedColumnsWithAudit commits the rotation and its audit together.
// Only the action, identity, ID and timestamp come from the caller; audit values
// are built here from row counts so no credential can be included accidentally.
func (s *SQLStore) RotateEncryptedColumnsWithAudit(
	ctx context.Context,
	decrypt func(string) (string, error),
	encrypt func(string) (string, error),
	audit AdminAuditLog,
) (map[string]int, error) {
	if audit.ID == "" || audit.AdminID == "" || audit.Action != "secrets.rotate" {
		return nil, errors.New("invalid secret rotation audit")
	}
	return s.rotateEncryptedColumns(ctx, decrypt, encrypt, &audit)
}

func (s *SQLStore) rotateEncryptedColumns(
	ctx context.Context,
	decrypt func(string) (string, error),
	encrypt func(string) (string, error),
	audit *AdminAuditLog,
) (map[string]int, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
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
			// Settings written by the admin API contain a JSON string. Older
			// rows may contain the ciphertext directly; preserve either format.
			ciphertext := item.enc
			var decoded *string
			jsonString := json.Unmarshal([]byte(item.enc), &decoded) == nil && decoded != nil
			if jsonString {
				ciphertext = *decoded
			}
			plain, err := decrypt(ciphertext)
			if err != nil {
				return nil, fmt.Errorf("admin_settings %q: decrypt: %w", item.key, err)
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("admin_settings %q: encrypt: %w", item.key, err)
			}
			if jsonString {
				encoded, err := json.Marshal(newEnc)
				if err != nil {
					return nil, fmt.Errorf("admin_settings %q: encode: %w", item.key, err)
				}
				newEnc = string(encoded)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE admin_settings SET value_json=?, version=version+1 WHERE key=?`), newEnc, item.key); err != nil {
				return nil, fmt.Errorf("admin_settings %q: update: %w", item.key, err)
			}
			counts["admin_settings"]++
		}
	}

	// SSO secrets share the gateway cipher. Bump the configuration version so
	// an editor that read the old ciphertext cannot restore it after rotation.
	{
		rows, err := tx.QueryContext(ctx, `SELECT provider, client_secret_enc FROM sso_provider_config WHERE client_secret_enc != ''`)
		if err != nil {
			return nil, fmt.Errorf("sso_provider_config select: %w", err)
		}
		type row struct{ provider, enc string }
		var items []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.provider, &r.enc); err != nil {
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
				return nil, fmt.Errorf("sso_provider_config %q: decrypt: %w", item.provider, err)
			}
			newEnc, err := encrypt(plain)
			if err != nil {
				return nil, fmt.Errorf("sso_provider_config %q: encrypt: %w", item.provider, err)
			}
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE sso_provider_config SET client_secret_enc=?, version=version+1 WHERE provider=?`), newEnc, item.provider); err != nil {
				return nil, fmt.Errorf("sso_provider_config %q: update: %w", item.provider, err)
			}
			counts["sso_provider_config"]++
		}
	}

	if audit != nil {
		encoded, err := json.Marshal(map[string]any{"rotated": counts})
		if err != nil {
			return nil, fmt.Errorf("encode rotation audit: %w", err)
		}
		audit.BeforeValue = ""
		audit.AfterValue = string(encoded)
		if err := s.insertAdminAudit(ctx, tx, *audit); err != nil {
			return nil, fmt.Errorf("write rotation audit: %w", err)
		}
	}
	// Reuse the audited-key commit cleanup: a failed SQLite COMMIT can leave
	// an open SQL transaction even though database/sql considers the Tx done.
	if err := commitAPIKeyTransaction(ctx, conn, tx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	// Rotation rewrites provider_configs.encrypted_api_key without going through
	// UpsertProvider, so the cached rows still hold keys encrypted under the old
	// cipher and would fail to decrypt on the next upstream call.
	s.providers.invalidate()
	return counts, nil
}
