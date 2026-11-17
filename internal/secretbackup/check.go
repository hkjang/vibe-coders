// Package secretbackup checks an isolated database copy without opening the
// gateway store, running migrations, starting workers, or changing encryption.
package secretbackup

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"vibe-coders/internal/secret"
)

var ErrInspection = errors.New("backup inspection could not be completed")

const maxRows = 1_000_000
const maxCiphertextBytes = 1 << 20

type StoreResult struct {
	Store   string `json:"store"`
	Matched int    `json:"matched"`
	Failed  int    `json:"failed"`
	Empty   int    `json:"empty"`
}

type Report struct {
	Format string        `json:"format"`
	Status string        `json:"status"`
	Stores []StoreResult `json:"stores"`
}

var inventory = []struct{ table, column, where string }{
	{"provider_configs", "encrypted_api_key", ""},
	{"mcp_upstreams", "encrypted_auth", ""},
	{"text2sql_exec_connections", "encrypted_dsn", ""},
	{"admin_settings", "value_json", " WHERE is_secret=1"},
	{"sso_provider_config", "client_secret_enc", ""},
}

// inspect shares one read-only serializable snapshot across all five stores.
// A missing table, interrupted scan, or failed transaction returns no partial
// report. Failed authentication includes a wrong key and damaged ciphertext;
// the tool cannot distinguish those cases. No plaintext or row identity escapes.
func inspect(ctx context.Context, db *sql.DB, key string) (Report, error) {
	cipher, err := secret.New(key)
	if err != nil || key == "" {
		return Report{}, ErrInspection
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelSerializable})
	if err != nil {
		return Report{}, ErrInspection
	}
	defer tx.Rollback()
	report := Report{Format: "vibe-secret-backup-check-v1", Status: "no_secrets", Stores: make([]StoreResult, 0, len(inventory))}
	total, matched, failed := 0, 0, 0
	for _, item := range inventory {
		// Only fixed identifiers enter SQL. Oversized values count as failures
		// without pulling their full contents into the inspection process.
		query := "SELECT CASE WHEN length(" + item.column + ") > 1048576 THEN NULL ELSE " + item.column + " END FROM " + item.table + item.where
		rows, err := tx.QueryContext(ctx, query)
		if err != nil {
			return Report{}, ErrInspection
		}
		result := StoreResult{Store: item.table}
		for rows.Next() {
			total++
			if total > maxRows {
				rows.Close()
				return Report{}, ErrInspection
			}
			var value sql.NullString
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				return Report{}, ErrInspection
			}
			if !value.Valid || len(value.String) > maxCiphertextBytes {
				result.Failed++
				continue
			}
			encoded := value.String
			if item.table == "admin_settings" {
				// Match rotation's support for legacy raw and JSON-string storage.
				var decoded *string
				if json.Unmarshal([]byte(encoded), &decoded) == nil && decoded != nil {
					encoded = *decoded
				}
			}
			if encoded == "" {
				result.Empty++
				continue
			}
			if !strings.HasPrefix(encoded, "v1:") {
				result.Failed++
				continue
			}
			if _, err := cipher.Decrypt(encoded); err != nil {
				result.Failed++
			} else {
				result.Matched++
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return Report{}, ErrInspection
		}
		if err := rows.Close(); err != nil {
			return Report{}, ErrInspection
		}
		matched += result.Matched
		failed += result.Failed
		report.Stores = append(report.Stores, result)
	}
	if err := tx.Rollback(); err != nil {
		return Report{}, ErrInspection
	}
	if failed > 0 {
		report.Status = "mismatch"
	} else if matched > 0 {
		report.Status = "matched"
	}
	return report, nil
}
