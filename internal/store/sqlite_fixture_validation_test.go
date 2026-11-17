package store

import (
	"database/sql"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"vibe-coders/internal/config"
)

func openStoreSQLiteAt(t *testing.T, path string) *SQLStore {
	t.Helper()
	db, err := storeSQLiteFixture.open(t.Context(), filepath.Join(t.TempDir(), "schema.db"), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func storeFixtureRawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func storeFixtureRows(t *testing.T, db *sql.DB, query string) [][]string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var result [][]string
	for rows.Next() {
		values := make([]sql.NullString, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		row := make([]string, len(values))
		for i, value := range values {
			if value.Valid {
				row[i] = "value:" + value.String
			} else {
				row[i] = "null"
			}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSQLiteStoreFixtureMatchesFreshMigration(t *testing.T) {
	// Independently execute production Migrate; do not use the template builder as
	// the expected result. Include every index/trigger, schema version and seed row.
	freshPath := filepath.Join(t.TempDir(), "fresh.db")
	fresh, err := Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: freshPath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fresh.Close() })
	if err := fresh.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	clonePath := filepath.Join(t.TempDir(), "clone.db")
	clone := openStoreSQLiteAt(t, clonePath)
	for _, query := range []string{`PRAGMA busy_timeout`, `PRAGMA synchronous`, `PRAGMA foreign_keys`, `PRAGMA journal_mode`} {
		if !reflect.DeepEqual(storeFixtureRows(t, clone.db, query), storeFixtureRows(t, fresh.db, query)) {
			t.Fatalf("fixture connection differs from production Open for %s", query)
		}
	}
	if clone.db.Stats().MaxOpenConnections != fresh.db.Stats().MaxOpenConnections {
		t.Fatal("fixture changed the production connection pool limit")
	}
	freshRaw, cloneRaw := storeFixtureRawDB(t, freshPath), storeFixtureRawDB(t, clonePath)
	for _, query := range []string{
		`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
		`PRAGMA schema_version`, `PRAGMA user_version`, `PRAGMA integrity_check`,
		`PRAGMA journal_mode`,
	} {
		want, got := storeFixtureRows(t, freshRaw, query), storeFixtureRows(t, cloneRaw, query)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("fixture differs from fresh migration for %s", query)
		}
	}
	if got := storeFixtureRows(t, cloneRaw, `PRAGMA integrity_check`); !reflect.DeepEqual(got, [][]string{{"value:ok"}}) {
		t.Fatalf("fixture integrity check failed: %v", got)
	}
	if got := storeFixtureRows(t, cloneRaw, `PRAGMA journal_mode`); !reflect.DeepEqual(got, [][]string{{"value:wal"}}) {
		t.Fatalf("fixture no longer uses production WAL mode: %v", got)
	}
	tables := storeFixtureRows(t, freshRaw, `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	for _, table := range tables {
		name := strings.TrimPrefix(table[0], "value:")
		query := `SELECT * FROM "` + strings.ReplaceAll(name, `"`, `""`) + `" ORDER BY rowid`
		got, want := storeFixtureRows(t, cloneRaw, query), storeFixtureRows(t, freshRaw, query)
		if name == "api_key_revision_secret" {
			// Fresh databases intentionally generate independent private secrets.
			// Check the complete row shape and entropy size without printing values;
			// the schema above and all other seed rows still compare exactly.
			for _, rows := range [][][]string{got, want} {
				if len(rows) != 1 || len(rows[0]) != 2 || rows[0][0] != "value:1" {
					t.Fatal("revision protection singleton differs from migration contract")
				}
				secret, err := hex.DecodeString(strings.TrimPrefix(rows[0][1], "value:"))
				if err != nil || len(secret) != 32 {
					t.Fatal("revision protection secret is not a 256-bit value")
				}
			}
			if reflect.DeepEqual(got, want) {
				t.Fatal("independent migration reused the fixture revision secret")
			}
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("fixture seed data differs for table %s", name)
		}
	}
}

func TestSQLiteStoreFixtureIsolatesDataSchemaAndLifecycle(t *testing.T) {
	firstPath, secondPath := filepath.Join(t.TempDir(), "first.db"), filepath.Join(t.TempDir(), "second.db")
	first, second := openStoreSQLiteAt(t, firstPath), openStoreSQLiteAt(t, secondPath)
	firstRaw, secondRaw := storeFixtureRawDB(t, firstPath), storeFixtureRawDB(t, secondPath)
	for _, statement := range []string{
		`INSERT INTO admin_settings(key, category, value_json, value_type, version, updated_by, updated_at) VALUES ('fixture.private', 'fixture', '"private"', 'string', 1, 'test', '2026-01-01T00:00:00Z')`,
		`CREATE TABLE fixture_private (id INTEGER PRIMARY KEY)`,
		`DROP INDEX idx_prompt_logs_request_id`,
	} {
		if _, err := firstRaw.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := firstRaw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if first.LifecycleContext().Err() == nil || second.LifecycleContext().Err() != nil {
		t.Fatal("closing one fixture did not isolate its worker lifecycle")
	}
	thirdPath := filepath.Join(t.TempDir(), "third.db")
	third := openStoreSQLiteAt(t, thirdPath)
	for _, db := range []*sql.DB{secondRaw, storeFixtureRawDB(t, thirdPath)} {
		for _, query := range []string{
			`SELECT key FROM admin_settings`,
			`SELECT name FROM sqlite_master WHERE name = 'fixture_private'`,
		} {
			if rows := storeFixtureRows(t, db, query); len(rows) != 0 {
				t.Fatalf("fixture retained another test's mutations: %s", query)
			}
		}
		if rows := storeFixtureRows(t, db, `SELECT name FROM sqlite_master WHERE name = 'idx_prompt_logs_request_id'`); len(rows) != 1 {
			t.Fatal("fixture retained another test's dropped index")
		}
	}
	for _, db := range []*SQLStore{second, third} {
		if err := db.Ping(t.Context()); err != nil {
			t.Fatalf("closing first fixture broke another database: %v", err)
		}
	}
	if info, err := os.Stat(thirdPath); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("fixture file permissions are not private: info=%v err=%v", info, err)
	}
}
