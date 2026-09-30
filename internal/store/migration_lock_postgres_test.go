package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

// These opt-in tests use separate real PostgreSQL sessions. No helper that has
// already run Migrate is used: startup lock acquisition is the subject here.
func TestPostgresMigrationLockWaitDoesNotBlockConcurrentIndex(t *testing.T) {
	f := newMigrationLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	holder := f.open(t, "holder")
	release, err := holder.acquireMigrationLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	releaseHolder := sync.OnceFunc(release)
	defer releaseHolder()

	waiter := f.startWaiter(t, ctx)
	f.waitForLockStatement(t, ctx)
	select {
	case result := <-waiter.done:
		waiter.accept(result)
		t.Fatal("waiter completed while the original migration lock was held")
	default:
	}

	// A partial concurrent index must wait for older snapshots, including the
	// snapshot of a blocking advisory-lock SELECT on a different connection.
	// The holder deliberately stays locked until this statement has finished.
	ddl := f.open(t, "index")
	ddlCtx, cancelDDL := context.WithTimeout(ctx, 3*time.Second)
	_, err = ddl.db.ExecContext(ddlCtx,
		`CREATE INDEX CONCURRENTLY migration_probe_partial ON migration_probe (id) WHERE id > 0`)
	cancelDDL()
	if err != nil {
		t.Fatalf("concurrent index could not finish while another migration waited: %v", err)
	}
	var valid bool
	if err := ddl.db.QueryRowContext(ctx, `
		SELECT i.indisvalid FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND c.relname = 'migration_probe_partial'`).Scan(&valid); err != nil || !valid {
		t.Fatalf("concurrent index validity: valid=%v error=%v", valid, err)
	}
	releaseHolder()
	result := waiter.receive(t)
	if result.err != nil {
		t.Fatalf("waiter did not acquire the released lock: %v", result.err)
	}
	waiter.release()
	f.assertNewOwner(t, ctx)
}

func TestPostgresMigrationLockCanceledWaiterPreservesOwner(t *testing.T) {
	f := newMigrationLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	holder := f.open(t, "holder")
	release, err := holder.acquireMigrationLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	releaseHolder := sync.OnceFunc(release)
	defer releaseHolder()
	waiter := f.startWaiter(t, ctx)
	f.waitForLockStatement(t, ctx)
	waiter.cancel()
	if result := waiter.receive(t); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("canceled waiter returned %v, want context.Canceled", result.err)
	}

	probe := f.open(t, "probe")
	conn, err := probe.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var acquired bool
	if err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, int64(864260796)).Scan(&acquired); err != nil {
		t.Fatal(err)
	}
	if acquired {
		_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, int64(864260796))
		t.Fatal("canceling the waiter released the original owner's lock")
	}
	releaseHolder()
	f.assertNewOwner(t, ctx)
}

type migrationLockFixture struct {
	dsn, schema, waiterName string
	observer                *SQLStore
}

func newMigrationLockFixture(t *testing.T) *migrationLockFixture {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set TEST_POSTGRES_DSN to check real PostgreSQL migration locking")
	}
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	f := &migrationLockFixture{dsn: dsn, schema: fmt.Sprintf("migration_lock_%x", suffix)}
	f.waiterName = f.schema + "_waiter"
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	f.observer = f.open(t, "observer")
	if _, err := f.observer.db.ExecContext(ctx, `CREATE SCHEMA `+quotePGIdentifier(f.schema)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := f.observer.db.ExecContext(cleanupCtx, `DROP SCHEMA `+quotePGIdentifier(f.schema)+` CASCADE`); err != nil {
			t.Errorf("remove owned migration-lock test schema: %v", err)
		}
	})
	if _, err := f.observer.db.ExecContext(ctx, `CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *migrationLockFixture) open(t *testing.T, role string) *SQLStore {
	t.Helper()
	parsed, err := url.Parse(f.dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		t.Fatal("migration lock tests require a PostgreSQL URL in TEST_POSTGRES_DSN")
	}
	params := parsed.Query()
	params.Set("search_path", f.schema)
	params.Set("application_name", f.schema+"_"+role)
	parsed.RawQuery = params.Encode()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "postgres", DSN: parsed.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func (f *migrationLockFixture) waitForLockStatement(t *testing.T, ctx context.Context) {
	t.Helper()
	observeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var query, state, event string
		err := f.observer.db.QueryRowContext(observeCtx, `
			SELECT query, state, COALESCE(wait_event, '') FROM pg_stat_activity
			WHERE application_name = $1 ORDER BY backend_start DESC LIMIT 1`, f.waiterName).Scan(&query, &state, &event)
		if err == nil && (strings.Contains(query, "SELECT pg_advisory_lock(") || strings.Contains(query, "SELECT pg_try_advisory_lock(")) {
			t.Logf("observed own migration waiter: state=%s wait_event=%s", state, event)
			return
		}
		select {
		case <-observeCtx.Done():
			t.Fatalf("own migration waiter did not enter lock statement: %v", observeCtx.Err())
		case <-tick.C:
		}
	}
}

type migrationLockResult struct {
	release func()
	err     error
}

type migrationLockWaiter struct {
	done   chan migrationLockResult
	cancel context.CancelFunc
	result *migrationLockResult
}

func (f *migrationLockFixture) startWaiter(t *testing.T, parent context.Context) *migrationLockWaiter {
	t.Helper()
	db := f.open(t, "waiter")
	ctx, cancel := context.WithCancel(parent)
	w := &migrationLockWaiter{done: make(chan migrationLockResult, 1), cancel: cancel}
	go func() {
		release, err := db.acquireMigrationLock(ctx)
		w.done <- migrationLockResult{release, err}
	}()
	t.Cleanup(func() {
		cancel()
		w.receive(t)
		w.release()
	})
	return w
}

func (w *migrationLockWaiter) accept(result migrationLockResult) migrationLockResult {
	w.result = &result
	return result
}

func (w *migrationLockWaiter) receive(t *testing.T) migrationLockResult {
	t.Helper()
	if w.result != nil {
		return *w.result
	}
	select {
	case result := <-w.done:
		return w.accept(result)
	case <-time.After(5 * time.Second):
		t.Fatal("owned migration waiter failed to stop within the cleanup deadline")
		return migrationLockResult{}
	}
}

func (w *migrationLockWaiter) release() {
	if w.result != nil && w.result.release != nil {
		w.result.release()
		w.result.release = nil
	}
}

func (f *migrationLockFixture) assertNewOwner(t *testing.T, ctx context.Context) {
	t.Helper()
	newOwner := f.open(t, "next_owner")
	acquireCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	release, err := newOwner.acquireMigrationLock(acquireCtx)
	if err != nil {
		t.Fatalf("new owner could not acquire after handoff: %v", err)
	}
	release()
}
