package store

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Exercise two complete startup migrations against the same real PostgreSQL
// database/schema. The external owner is only a start barrier: both Migrate
// calls must enter their actual advisory SQL before either can proceed.
func TestPostgresMigrationConcurrentSameSchema(t *testing.T) {
	f := newMigrationLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	holder := f.open(t, "barrier")
	release, err := holder.acquireMigrationLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	releaseBarrier := sync.OnceFunc(release)
	defer releaseBarrier()
	first := f.open(t, "migrate_a")
	second := f.open(t, "migrate_b")
	type migrationResult struct {
		role string
		err  error
	}
	results := make(chan migrationResult, 2)
	received := make(map[string]bool)
	accept := func(result migrationResult) {
		t.Helper()
		if (result.role != "migrate_a" && result.role != "migrate_b") || received[result.role] {
			t.Fatal("unexpected or duplicate owned migration result")
		}
		received[result.role] = true
	}
	// Drain both operations before the fixture closes its pools or drops the
	// schema. Cancellation and cleanup never rely on the failed test context.
	t.Cleanup(func() {
		cancel()
		releaseBarrier()
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		for len(received) < 2 {
			select {
			case result := <-results:
				accept(result)
			case <-cleanupCtx.Done():
				t.Error("owned full migrations did not stop before cleanup deadline")
				return
			}
		}
	})
	go func() { results <- migrationResult{"migrate_a", first.Migrate(ctx)} }()
	go func() { results <- migrationResult{"migrate_b", second.Migrate(ctx)} }()
	waitForBothMigrationStatements(t, f, ctx)
	select {
	case result := <-results:
		accept(result)
		t.Fatal("a full migration finished while the external start barrier held the lock")
	default:
	}
	releaseBarrier()
	for len(received) < 2 {
		select {
		case result := <-results:
			accept(result)
			if result.err != nil {
				t.Errorf("actual %s failed after the shared start barrier: %v", result.role, result.err)
			}
		case <-ctx.Done():
			t.Fatalf("actual concurrent migrations exceeded their bounded context: %v", ctx.Err())
		}
	}
	if t.Failed() {
		return
	}
	var tables int
	if err := f.observer.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = $1
		AND table_name IN ('api_keys', 'request_logs', 'admin_settings')`, f.schema).Scan(&tables); err != nil || tables != 3 {
		t.Fatalf("full migrations did not establish the expected schema: tables=%d error=%v", tables, err)
	}
	var validIndex int
	if err := f.observer.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = 'idx_api_keys_team_id'
		AND i.indisvalid AND i.indisready`, f.schema).Scan(&validIndex); err != nil || validIndex != 1 {
		t.Fatalf("concurrent migration index is not valid and ready: count=%d error=%v", validIndex, err)
	}
	// Both Migrate defers must have released their session lock, not merely
	// completed their DDL while leaving a pooled lock owned by a previous call.
	f.assertNewOwner(t, ctx)
}

func waitForBothMigrationStatements(t *testing.T, f *migrationLockFixture, parent context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var entered int
		err := f.observer.db.QueryRowContext(ctx, `
			SELECT COUNT(DISTINCT application_name) FROM pg_stat_activity
			WHERE application_name IN ($1, $2)
			AND (query LIKE '%SELECT pg_advisory_lock(%'
			OR query LIKE '%SELECT pg_try_advisory_lock(%')`,
			f.schema+"_migrate_a", f.schema+"_migrate_b").Scan(&entered)
		if err != nil {
			t.Fatalf("could not observe owned migration entry: %v", err)
		}
		if entered == 2 {
			t.Log("both real Migrate calls entered their advisory statement before barrier release")
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("both owned migrations did not enter lock SQL: %v", ctx.Err())
		case <-tick.C:
		}
	}
}
