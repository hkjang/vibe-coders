package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"vibe-coders/internal/config"
)

// Most store tests need an isolated current schema, not repeated executions of
// the same empty-database DDL. Only immutable, fully checkpointed file bytes are
// shared. Every fixture has a private file, normal Open connection/PRAGMA setup,
// fresh caches, lifecycle and revision secret. Explicit fresh/upgrade migration
// tests and the PostgreSQL helper continue to exercise production Migrate.
type sqliteStoreFixture struct {
	once  sync.Once
	image string
	err   error
}

var storeSQLiteFixture sqliteStoreFixture

func buildStoreSQLiteImage(ctx context.Context, path string) (string, error) {
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		return "", err
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		return "", fmt.Errorf("migrate store fixture: %w", err)
	}
	// A copied protection secret would make unrelated test databases accept the
	// same reviewed snapshot and mask cross-database authorization regressions.
	// Recreate it through the production initializer on every opened copy.
	if _, err := db.db.ExecContext(ctx, `DELETE FROM api_key_revision_secret`); err != nil {
		return "", err
	}
	if err := db.Close(); err != nil {
		return "", err
	}
	if info, err := os.Stat(path + "-wal"); err == nil && info.Size() != 0 {
		return "", errors.New("store fixture still depends on WAL pages")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	image, err := os.ReadFile(path)
	return string(image), err
}

func (fixture *sqliteStoreFixture) open(ctx context.Context, schemaPath, path string) (*SQLStore, error) {
	fixture.once.Do(func() {
		fixture.image, fixture.err = buildStoreSQLiteImage(ctx, schemaPath)
	})
	if fixture.err != nil {
		return nil, fixture.err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, writeErr := file.WriteString(fixture.image)
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return nil, err
	}
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		return nil, err
	}
	if err := db.ensureAPIKeyRevisionSecret(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func openSQLiteStoreForTest(t *testing.T) *SQLStore {
	t.Helper()
	root := t.TempDir()
	db, err := storeSQLiteFixture.open(context.Background(), filepath.Join(root, "schema.db"), filepath.Join(root, "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
