package proxy

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// A recursive CTE that counts far enough to run for many seconds on any CI runner. It
// stands in for a runaway query on a MySQL or SQLite source, where no server-side
// statement_timeout exists and only the context deadline can stop it.
const slowExecQuery = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 200000000) SELECT count(*) FROM c`

// The same shape, short enough to finish well inside a 200ms statement timeout.
const fastExecQuery = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x FROM c`

func openExecTimeoutTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "exec.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// The statement timeout must bound the query on the default (sqlite) path, not only on
// pgx. Before the fix the 30s fallback deadline was the only limit and this test waited
// the full 30 seconds before getting a result back.
func TestExecuteReadOnlyQueryStatementTimeoutStopsSlowQueryOnDefaultDriver(t *testing.T) {
	for _, driver := range []string{"", "sqlite"} {
		t.Run("driver="+driver, func(t *testing.T) {
			db := openExecTimeoutTestDB(t)
			start := time.Now()
			_, _, _, err := executeReadOnlyQuery(context.Background(), db, driver, slowExecQuery, 100, 200*time.Millisecond, "")
			elapsed := time.Since(start)
			if err == nil {
				t.Fatalf("slow query returned no error after %s; statement timeout not applied", elapsed)
			}
			if elapsed > 5*time.Second {
				t.Fatalf("slow query took %s to fail (%v); statement timeout not applied", elapsed, err)
			}
			// modernc sqlite surfaces a cancelled context either as the context error or as
			// its own "interrupted" error; both mean the deadline stopped the statement.
			if !errors.Is(err, context.DeadlineExceeded) && !strings.Contains(strings.ToLower(err.Error()), "interrupt") {
				t.Fatalf("unexpected error kind: %v", err)
			}
		})
	}
}

func TestExecuteReadOnlyQueryStatementTimeoutLetsFastQueryThrough(t *testing.T) {
	for _, driver := range []string{"", "sqlite"} {
		t.Run("driver="+driver, func(t *testing.T) {
			db := openExecTimeoutTestDB(t)
			cols, rows, count, err := executeReadOnlyQuery(context.Background(), db, driver, fastExecQuery, 10, 200*time.Millisecond, "")
			if err != nil {
				t.Fatalf("fast query failed under statement timeout: %v", err)
			}
			if len(cols) != 1 || cols[0] != "x" {
				t.Fatalf("columns = %v, want [x]", cols)
			}
			if count != 1000 {
				t.Fatalf("count = %d, want 1000 (row counting must be unaffected by the timeout)", count)
			}
			if len(rows) != 10 {
				t.Fatalf("materialized rows = %d, want rowLimit 10", len(rows))
			}
			if rows[0][0] != "1" || rows[9][0] != "10" {
				t.Fatalf("rows = %v, want 1..10", rows)
			}
		})
	}
}

// stmtTimeout == 0 keeps the previous behaviour: only the 30s fallback applies.
func TestExecuteReadOnlyQueryZeroStatementTimeoutKeepsFallback(t *testing.T) {
	db := openExecTimeoutTestDB(t)
	_, rows, count, err := executeReadOnlyQuery(context.Background(), db, "sqlite", fastExecQuery, 10, 0, "")
	if err != nil {
		t.Fatalf("fast query failed with stmtTimeout=0: %v", err)
	}
	if count != 1000 || len(rows) != 10 {
		t.Fatalf("count=%d rows=%d, want 1000/10", count, len(rows))
	}
}
