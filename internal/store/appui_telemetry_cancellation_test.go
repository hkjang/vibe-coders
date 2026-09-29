package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func assertAppUITelemetryBusyTimeout(t *testing.T, db *SQLStore, want int) {
	t.Helper()
	if db.dialect != "sqlite" {
		return
	}
	var got int
	if err := db.db.QueryRow(`PRAGMA busy_timeout`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("connection busy_timeout=%d, want restored %d", got, want)
	}
}

func TestAppUITelemetrySQLiteScopedLockWait(t *testing.T) {
	stores := appUITelemetryStores(t, 2)
	if stores[0].dialect != "sqlite" {
		t.Skip("SQLite-specific connection setting")
	}
	blocker, subject := stores[0], stores[1]
	// A non-default value proves restoration does not merely hard-code 10000.
	if _, err := subject.db.Exec(`PRAGMA busy_timeout = 7231`); err != nil {
		t.Fatal(err)
	}
	tx, err := blocker.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE app_ui_telemetry_capacity SET live_visits = live_visits WHERE singleton = 1`); err != nil {
		t.Fatal(err)
	}
	// Bound even a regression to the old multi-second SQLite busy handler.
	release := time.AfterFunc(3*time.Second, func() { _ = tx.Rollback() })
	defer release.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	now := time.Now().UTC()
	start := time.Now()
	accepted, err := subject.RecordAppUITelemetry(ctx, "overview", strings.Repeat("a", 32), false, now)
	elapsed := time.Since(start)
	if accepted || err == nil {
		t.Fatalf("blocked writer accepted=%v err=%v", accepted, err)
	}
	if elapsed >= time.Second {
		t.Fatalf("lossy telemetry occupied the SQLite connection for %s", elapsed)
	}
	t.Logf("blocked writer returned after %s", elapsed)
	assertAppUITelemetryBusyTimeout(t, subject, 7231)
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, subject, 0)
	if accepted, err := subject.RecordAppUITelemetry(context.Background(), "overview", strings.Repeat("a", 32), false, now); err != nil || !accepted {
		t.Fatalf("subsequent record accepted=%v err=%v", accepted, err)
	}
	assertAppUITelemetryBusyTimeout(t, subject, 7231)
	if accepted, err := subject.RecordAppUITelemetry(context.Background(), "gateway.chat", strings.Repeat("a", 32), true, now); accepted || !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatalf("cross-feature record accepted=%v err=%v", accepted, err)
	}
	assertAppUITelemetryBusyTimeout(t, subject, 7231)
	if err := subject.PurgeAppUITelemetry(context.Background(), now.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryBusyTimeout(t, subject, 7231)
	assertAppUITelemetryCapacity(t, subject, 0)
}

func TestAppUITelemetryCanceledRecordAndPoolRecovery(t *testing.T) {
	stores := appUITelemetryStores(t, 2)
	blocker, subject := stores[0], stores[1]
	tx, err := blocker.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE app_ui_telemetry_capacity SET live_visits = live_visits WHERE singleton = 1`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	now := time.Now().UTC()
	if accepted, err := subject.RecordAppUITelemetry(ctx, "overview", strings.Repeat("b", 32), true, now); accepted || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("canceled record accepted=%v err=%v", accepted, err)
	}
	assertAppUITelemetryBusyTimeout(t, subject, 10000)
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, subject, 0)
	if accepted, err := subject.RecordAppUITelemetry(context.Background(), "overview", strings.Repeat("b", 32), true, now); err != nil || !accepted {
		t.Fatalf("subsequent record accepted=%v err=%v", accepted, err)
	}
	assertAppUITelemetryBusyTimeout(t, subject, 10000)
	assertAppUITelemetryCapacity(t, subject, 1)
}

func TestAppUITelemetryCancellationRollsBackReservation(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tx, cleanup, err := db.lockAppUITelemetry(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE app_ui_telemetry_capacity SET live_visits = 1 WHERE singleton = 1`); err != nil {
		cleanup()
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, db.bind(`INSERT INTO app_ui_telemetry_visits
		(visit_hash, feature_id, first_seen_epoch, legacy_open) VALUES (?, ?, ?, ?)`),
		strings.Repeat("c", 64), "overview", time.Now().Unix(), 1); err != nil {
		cleanup()
		t.Fatal(err)
	}
	cancel()
	if err := tx.Commit(); err == nil {
		cleanup()
		t.Fatal("canceled transaction committed")
	}
	cleanup()
	assertAppUITelemetryBusyTimeout(t, db, 10000)
	assertAppUITelemetryCapacity(t, db, 0)
}
