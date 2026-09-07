package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/datadir"
)

func requirePOSIXPermissions(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not enforced on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission bits; the failure cannot be provoked")
	}
}

// The runtime image runs as nonroot; a volume another user wrote used to surface
// only as SQLite's "attempt to write a readonly database" during migration.
func TestOpenSQLiteExplainsUnwritableDataDirectory(t *testing.T) {
	requirePOSIXPermissions(t)
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	_, err := Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(dir, "gateway.db")})
	var dataErr *datadir.Error
	if !errors.As(err, &dataErr) {
		t.Fatalf("expected *datadir.Error, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "repair-data-dir "+dir) {
		t.Fatalf("error does not tell the operator how to repair the volume:\n%v", err)
	}
}

func TestOpenSQLiteExplainsReadOnlyDatabaseFile(t *testing.T) {
	requirePOSIXPermissions(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gateway.db")
	if err := os.WriteFile(dbPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dbPath, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dbPath, 0o644) })

	_, err := Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: dbPath + "?_pragma=busy_timeout(1000)"})
	var dataErr *datadir.Error
	if !errors.As(err, &dataErr) {
		t.Fatalf("expected *datadir.Error, got %T: %v", err, err)
	}
	if len(dataErr.Problems) != 1 || dataErr.Problems[0].Path != dbPath {
		t.Fatalf("expected the database file to be the single problem, got %+v", dataErr.Problems)
	}
}

func TestOpenSQLiteInMemorySkipsDataDirectoryCheck(t *testing.T) {
	s, err := Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: "file::memory:?cache=shared"})
	if err != nil {
		t.Fatalf("in-memory DSN must not be subject to the data directory preflight: %v", err)
	}
	s.Close()
}
