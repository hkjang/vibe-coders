package proxy

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"

	_ "modernc.org/sqlite"
)

// TestText2SQLValidationDBFallback verifies that without a configured SQL Digital
// Twin the validation DB falls back to the execute DB + driver.
func TestText2SQLValidationDBFallback(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "exec.db")
	s := &Server{cfg: config.Config{Text2SQL: config.Text2SQLConfig{
		ExecDriver: "sqlite",
		ExecDSN:    dsn,
	}}}
	db, driver, err := s.text2sqlValidationDB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if d := s.t2sExec.Load(); d != nil {
			d.Close()
		}
	})
	if driver != "sqlite" {
		t.Errorf("driver = %q, want sqlite (exec fallback)", driver)
	}
	if got := s.t2sExec.Load(); got != db {
		t.Error("fallback should open and cache the exec DB")
	}
	if s.t2sTwin.Load() != nil {
		t.Error("twin pointer must stay nil when TwinDSN is empty")
	}
}

// TestText2SQLValidationDBTwin verifies that when a twin DSN is configured, the
// validation DB points at the twin (not the exec DB), and golden result-equivalence
// runs against it.
func TestText2SQLValidationDBTwin(t *testing.T) {
	ctx := context.Background()
	twinDSN := filepath.Join(t.TempDir(), "twin.db")

	// Seed the twin with a small table.
	seed, err := sql.Open("sqlite", twinDSN)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.ExecContext(ctx, `CREATE TABLE itsm_requests (id INTEGER, dept TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, v := range [][2]any{{1, "infra"}, {2, "infra"}, {3, "apps"}} {
		if _, err := seed.ExecContext(ctx, `INSERT INTO itsm_requests (id, dept) VALUES (?, ?)`, v[0], v[1]); err != nil {
			t.Fatal(err)
		}
	}
	seed.Close()

	s := &Server{cfg: config.Config{Text2SQL: config.Text2SQLConfig{
		// Exec DSN deliberately points at a non-existent table so a leak to the
		// exec DB would fail the equivalence check.
		ExecDriver:   "sqlite",
		ExecDSN:      filepath.Join(t.TempDir(), "exec.db"),
		TwinDriver:   "sqlite",
		TwinDSN:      twinDSN,
		MaxLimit:     1000,
		DefaultLimit: 1000,
	}}}

	db, driver, err := s.text2sqlValidationDB()
	if err != nil {
		t.Fatal(err)
	}
	// Close cached handles so Windows can remove the temp files on cleanup.
	t.Cleanup(func() {
		if d := s.t2sTwin.Load(); d != nil {
			d.Close()
		}
		if d := s.t2sExec.Load(); d != nil {
			d.Close()
		}
	})
	if driver != "sqlite" {
		t.Errorf("driver = %q, want sqlite", driver)
	}
	if s.t2sTwin.Load() != db {
		t.Error("twin DB should be cached on t2sTwin")
	}

	// Two equivalent queries (different ORDER BY) → result-equivalent.
	ok, detail := s.goldenResultEquivalent(ctx,
		"SELECT dept FROM itsm_requests ORDER BY id",
		"SELECT dept FROM itsm_requests ORDER BY dept")
	if !ok {
		t.Errorf("equivalent queries should match, got detail %q", detail)
	}

	// A query returning a different multiset → mismatch.
	ok, _ = s.goldenResultEquivalent(ctx,
		"SELECT dept FROM itsm_requests WHERE dept = 'infra'",
		"SELECT dept FROM itsm_requests")
	if ok {
		t.Error("queries returning different rows should not match")
	}
}
