package secretbackup

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

var ErrBackup = errors.New("isolated backup unavailable or unsafe")

// SQLite accepts a frozen, standalone SQLite backup, not a DSN or a live data
// directory. immutable+mode=ro prevents database and sidecar writes. Nonempty
// WAL/journal files are rejected because ignoring them would inspect stale data.
func SQLite(ctx context.Context, path, key string) (Report, error) {
	db, err := openSQLite(path)
	if err != nil {
		return Report{}, err
	}
	defer db.Close()
	return inspect(ctx, db, key)
}

func openSQLite(path string) (*sql.DB, error) {
	if path == "" {
		return nil, ErrBackup
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, ErrBackup
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrBackup
	}
	for _, suffix := range []string{"-wal", "-journal"} {
		side, err := os.Lstat(path + suffix)
		if err == nil && (!side.Mode().IsRegular() || side.Size() != 0) {
			return nil, ErrBackup
		}
		if err != nil && !os.IsNotExist(err) {
			return nil, ErrBackup
		}
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	q := url.Values{"mode": {"ro"}, "immutable": {"1"}, "_pragma": {"query_only(1)", "busy_timeout(5000)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, ErrBackup
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// PostgreSQL accepts only an explicitly supplied isolated restore connection.
// The session default and the inspection transaction both enforce read-only
// access. Credentials and server errors must never appear in the report.
func PostgreSQL(ctx context.Context, dsn, key string) (Report, error) {
	if strings.TrimSpace(dsn) == "" {
		return Report{}, ErrBackup
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return Report{}, ErrBackup
	}
	config.RuntimeParams["default_transaction_read_only"] = "on"
	db := stdlib.OpenDB(*config)
	db.SetMaxOpenConns(1)
	defer db.Close()
	return inspect(ctx, db, key)
}
