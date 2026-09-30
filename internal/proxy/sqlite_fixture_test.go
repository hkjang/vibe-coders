package proxy

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// HTTP tests need separate, fully migrated SQLite databases, not separate executions
// of the same empty-schema DDL. Under -race, reparsing the large SQLite schema for
// every fixture dominates the package's runtime. Build the current schema once,
// close its last connection (checkpointing WAL), and keep only immutable file bytes.
// Each test still opens a private file through the normal production store.Open,
// with its own WAL, connection pool, caches and lifecycle. No server/env settings,
// pricing, users or other per-test data are ever added to the source image.
// PostgreSQL and explicit fresh/upgrade migration tests do not use this helper.
type sqliteFixtureTemplate struct {
	once  sync.Once
	image string
	err   error
}

var proxySQLiteTemplate sqliteFixtureTemplate

func (template *sqliteFixtureTemplate) write(ctx context.Context, schemaPath, destination string) error {
	template.once.Do(func() {
		template.image, template.err = buildSQLiteFixtureImage(ctx, schemaPath)
	})
	if template.err != nil {
		return template.err
	}
	if err := os.WriteFile(destination, []byte(template.image), 0o600); err != nil {
		return fmt.Errorf("write isolated SQLite fixture: %w", err)
	}
	return nil
}

func buildSQLiteFixtureImage(ctx context.Context, path string) (string, error) {
	db, err := store.Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		return "", fmt.Errorf("open SQLite fixture schema: %w", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		return "", fmt.Errorf("migrate SQLite fixture schema: %w", err)
	}
	if err := db.Close(); err != nil {
		return "", fmt.Errorf("close SQLite fixture schema: %w", err)
	}
	// Never copy an image whose committed pages still depend on a sidecar file.
	if info, err := os.Stat(path + "-wal"); err == nil && info.Size() != 0 {
		return "", errors.New("SQLite fixture schema still has uncheckpointed WAL data")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect SQLite fixture WAL: %w", err)
	}
	image, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read SQLite fixture schema: %w", err)
	}
	return string(image), nil
}

func openSQLiteTestStore(t *testing.T, path string) *store.SQLStore {
	t.Helper()
	if err := proxySQLiteTemplate.write(context.Background(), filepath.Join(t.TempDir(), "schema.db"), path); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func fixtureRawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func fixtureRows(t *testing.T, db *sql.DB, query string) [][]string {
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

func TestSQLiteFixtureMatchesFreshMigration(t *testing.T) {
	// Independently execute production Migrate; do not use the template builder as
	// the expected result. Include every index/trigger, schema version and seed row.
	freshPath := filepath.Join(t.TempDir(), "fresh.db")
	fresh, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: freshPath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fresh.Close() })
	if err := fresh.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	clonePath := filepath.Join(t.TempDir(), "clone.db")
	openSQLiteTestStore(t, clonePath)
	freshRaw, cloneRaw := fixtureRawDB(t, freshPath), fixtureRawDB(t, clonePath)
	for _, query := range []string{
		`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
		`PRAGMA schema_version`, `PRAGMA user_version`, `PRAGMA integrity_check`,
		`PRAGMA journal_mode`,
	} {
		want, got := fixtureRows(t, freshRaw, query), fixtureRows(t, cloneRaw, query)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("fixture differs from fresh migration for %s", query)
		}
	}
	if got := fixtureRows(t, cloneRaw, `PRAGMA integrity_check`); !reflect.DeepEqual(got, [][]string{{"value:ok"}}) {
		t.Fatalf("fixture integrity check failed: %v", got)
	}
	if got := fixtureRows(t, cloneRaw, `PRAGMA journal_mode`); !reflect.DeepEqual(got, [][]string{{"value:wal"}}) {
		t.Fatalf("fixture no longer uses production WAL mode: %v", got)
	}
	tables := fixtureRows(t, freshRaw, `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	for _, table := range tables {
		name := strings.TrimPrefix(table[0], "value:")
		query := `SELECT * FROM "` + strings.ReplaceAll(name, `"`, `""`) + `" ORDER BY rowid`
		if !reflect.DeepEqual(fixtureRows(t, cloneRaw, query), fixtureRows(t, freshRaw, query)) {
			t.Fatalf("fixture seed data differs for table %s", name)
		}
	}
}

func TestSQLiteFixtureIsolatesDataSchemaAndLifecycle(t *testing.T) {
	firstPath, secondPath := filepath.Join(t.TempDir(), "first.db"), filepath.Join(t.TempDir(), "second.db")
	first, second := openSQLiteTestStore(t, firstPath), openSQLiteTestStore(t, secondPath)
	firstRaw, secondRaw := fixtureRawDB(t, firstPath), fixtureRawDB(t, secondPath)
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
	third := openSQLiteTestStore(t, thirdPath)
	for _, db := range []*sql.DB{secondRaw, fixtureRawDB(t, thirdPath)} {
		for _, query := range []string{
			`SELECT key FROM admin_settings`,
			`SELECT name FROM sqlite_master WHERE name = 'fixture_private'`,
		} {
			if rows := fixtureRows(t, db, query); len(rows) != 0 {
				t.Fatalf("fixture retained another test's mutations: %s", query)
			}
		}
		if rows := fixtureRows(t, db, `SELECT name FROM sqlite_master WHERE name = 'idx_prompt_logs_request_id'`); len(rows) != 1 {
			t.Fatal("fixture retained another test's dropped index")
		}
	}
	for _, db := range []*store.SQLStore{second, third} {
		if err := db.Ping(t.Context()); err != nil {
			t.Fatalf("closing first fixture broke another database: %v", err)
		}
	}
	if info, err := os.Stat(thirdPath); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("fixture file permissions are not private: info=%v err=%v", info, err)
	}
}

func TestSQLiteFixtureTemplateConcurrentInitialization(t *testing.T) {
	var template sqliteFixtureTemplate
	const count = 6
	root := t.TempDir()
	results := make(chan error, count)
	start := make(chan struct{})
	for i := range count {
		go func() {
			<-start
			results <- template.write(context.Background(), filepath.Join(root, fmt.Sprintf("schema-%d.db", i)), filepath.Join(root, fmt.Sprintf("fixture-%d.db", i)))
		}()
	}
	close(start)
	for range count {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	if t.Failed() {
		return // all writers have completed before t.TempDir cleanup begins
	}
	schemas, err := filepath.Glob(filepath.Join(root, "schema-*.db"))
	if err != nil || len(schemas) != 1 {
		t.Fatalf("expected one schema migration, got %v: %v", schemas, err)
	}
	for i := range count {
		db := fixtureRawDB(t, filepath.Join(root, fmt.Sprintf("fixture-%d.db", i)))
		if got := fixtureRows(t, db, `PRAGMA integrity_check`); !reflect.DeepEqual(got, [][]string{{"value:ok"}}) {
			t.Fatalf("concurrent fixture %d has incomplete checkpointed schema: %v", i, got)
		}
		if rows := fixtureRows(t, db, `SELECT started_at FROM usage_rollup_state`); len(rows) != 1 {
			t.Fatalf("concurrent fixture %d lost post-migration seed data", i)
		}
	}
}

func TestSQLiteFixtureTemplateSurvivesSourceCleanup(t *testing.T) {
	var template sqliteFixtureTemplate
	var sourcePath string
	t.Run("initialize", func(t *testing.T) {
		sourcePath = filepath.Join(t.TempDir(), "schema.db")
		if err := template.write(t.Context(), sourcePath, filepath.Join(t.TempDir(), "first.db")); err != nil {
			t.Fatal(err)
		}
	})
	if _, err := os.Stat(sourcePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source fixture was not cleaned up by its owner: %v", err)
	}
	clonePath := filepath.Join(t.TempDir(), "clone.db")
	if err := template.write(t.Context(), sourcePath, clonePath); err != nil {
		t.Fatal(err)
	}
	if got := fixtureRows(t, fixtureRawDB(t, clonePath), `PRAGMA integrity_check`); !reflect.DeepEqual(got, [][]string{{"value:ok"}}) {
		t.Fatalf("fixture depended on original source path or WAL: %v", got)
	}
}

func TestSQLiteFixtureTemplatePreservesInitializationError(t *testing.T) {
	var template sqliteFixtureTemplate
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := t.TempDir()
	first := template.write(ctx, filepath.Join(root, "schema.db"), filepath.Join(root, "first.db"))
	if !errors.Is(first, context.Canceled) {
		t.Fatalf("expected canceled initialization, got %v", first)
	}
	second := template.write(context.Background(), filepath.Join(root, "other-schema.db"), filepath.Join(root, "second.db"))
	if first != second {
		t.Fatalf("later caller lost initialization failure: first=%v second=%v", first, second)
	}
	for _, name := range []string{"first.db", "second.db", "other-schema.db"} {
		if _, err := os.Stat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("failed initialization created reusable fixture %s: %v", name, err)
		}
	}
}
