package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

// Like the existing store suite, these exercise PostgreSQL when
// TEST_POSTGRES_DSN is set. Peers use independent pools against one database,
// so the concurrency tests cannot pass merely because of a process-local lock.
func appUITelemetryStores(t *testing.T, peers int) []*SQLStore {
	t.Helper()
	ctx := context.Background()
	cfg := config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "telemetry.db")}
	var primary *SQLStore
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		primary = openPostgresStoreForTest(t, dsn)
		var schema string
		if err := primary.db.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
			t.Fatal(err)
		}
		separator := "?"
		if strings.Contains(dsn, "?") {
			separator = "&"
		}
		cfg = config.DatabaseConfig{Driver: "postgres", DSN: dsn + separator + "search_path=" + schema}
	} else {
		var err error
		primary, err = Open(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := primary.Migrate(ctx); err != nil {
			primary.Close()
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = primary.Close() })
	stores := []*SQLStore{primary}
	for len(stores) < peers {
		peer, err := Open(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = peer.Close() })
		stores = append(stores, peer)
	}
	return stores
}

func assertAppUITelemetryCapacity(t *testing.T, db *SQLStore, want int64) {
	t.Helper()
	var count, reserved int64
	if err := db.db.QueryRow(`SELECT COUNT(*) FROM app_ui_telemetry_visits`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := db.db.QueryRow(`SELECT live_visits FROM app_ui_telemetry_capacity WHERE singleton = 1`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if count != want || reserved != want {
		t.Fatalf("visits=%d reserved=%d, want %d for both", count, reserved, want)
	}
}

// SQLite intake deliberately drops contended observations after its short lock
// wait. Tests still require every successfully accepted event to be reflected
// exactly; PostgreSQL and non-contention errors retain the strict expectations.
func appUITelemetryExpectedBusyDrop(db *SQLStore, err error) bool {
	var coded interface{ Code() int }
	return db.dialect == "sqlite" && errors.As(err, &coded) && coded.Code()&0xff == 5
}

func TestAppUITelemetryDeduplicationReorderingAndPrivacy(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := context.Background()
	now := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	visitID := strings.Repeat("a", 32)
	for _, event := range []struct {
		id     string
		legacy bool
		at     time.Time
	}{
		{visitID, false, now},
		{visitID, false, now.Add(time.Hour)},
		{visitID, true, now.Add(2 * time.Hour)},
		{visitID, true, now.Add(3 * time.Hour)},
		{strings.Repeat("b", 32), true, now.Add(4 * time.Hour)},
		{strings.Repeat("b", 32), false, now.Add(5 * time.Hour)},
	} {
		accepted, err := db.RecordAppUITelemetry(ctx, "gateway.chat", event.id, event.legacy, event.at)
		if err != nil || !accepted {
			t.Fatalf("record: accepted=%v err=%v", accepted, err)
		}
	}
	if accepted, err := db.RecordAppUITelemetry(ctx, "overview", visitID, true, now.Add(6*time.Hour)); accepted || !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatalf("cross-feature reuse: accepted=%v err=%v", accepted, err)
	}
	counts, err := db.AppUITelemetrySummary(ctx, now, now.Add(6*time.Hour))
	want := []AppUITelemetryCount{{FeatureID: "gateway.chat", Visits: 2, LegacyOpens: 2}}
	if err != nil || !reflect.DeepEqual(counts, want) {
		t.Fatalf("summary=%+v err=%v, want %+v", counts, err, want)
	}
	assertAppUITelemetryCapacity(t, db, 2)
	digest := sha256.Sum256([]byte(visitID))
	var firstSeen int64
	if err := db.db.QueryRowContext(ctx, db.bind(`SELECT first_seen_epoch FROM app_ui_telemetry_visits
		WHERE visit_hash = ?`), hex.EncodeToString(digest[:])).Scan(&firstSeen); err != nil {
		t.Fatalf("visit was not stored under its SHA256 digest: %v", err)
	}
	if firstSeen != now.Unix() {
		t.Fatalf("duplicates extended first receipt to %d, want %d", firstSeen, now.Unix())
	}
	rows, err := db.db.QueryContext(ctx, `SELECT * FROM app_ui_telemetry_visits`)
	if err != nil {
		t.Fatal(err)
	}
	columns, err := rows.Columns()
	rows.Close()
	if err != nil || !reflect.DeepEqual(columns, []string{"visit_hash", "feature_id", "first_seen_epoch", "legacy_open"}) {
		t.Fatalf("unexpected telemetry columns: %v err=%v", columns, err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	assertAppUITelemetryCapacity(t, db, 2)
}

func TestAppUITelemetryRejectsUnboundedInputs(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now := time.Now().UTC()
	for _, input := range []struct {
		feature string
		id      string
		at      time.Time
	}{
		{"", strings.Repeat("a", 32), now},
		{strings.Repeat("a", 65), strings.Repeat("a", 32), now},
		{"gateway.chat?prompt=secret", strings.Repeat("a", 32), now},
		{"https://private.example/path", strings.Repeat("a", 32), now},
		{"person@example.com", strings.Repeat("a", 32), now},
		{"gateway..chat", strings.Repeat("a", 32), now},
		{"gateway.chat", "", now},
		{"gateway.chat", strings.Repeat("a", 33), now},
		{"gateway.chat", strings.Repeat("A", 32), now},
		{"gateway.chat", strings.Repeat("z", 32), now},
		{"gateway.chat", strings.Repeat("a", 32), time.Time{}},
	} {
		accepted, err := db.RecordAppUITelemetry(context.Background(), input.feature, input.id, false, input.at)
		if accepted || !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatalf("invalid input accepted=%v err=%v", accepted, err)
		}
		if err.Error() != "invalid UI telemetry input" {
			t.Fatalf("validation error exposed input: %q", err)
		}
	}
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUITelemetryRetentionAndSummaryWindow(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := context.Background()
	now := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	cutoff := now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour)
	for index, at := range []time.Time{cutoff.Add(-time.Second), cutoff, cutoff.Add(time.Second)} {
		if accepted, err := db.RecordAppUITelemetry(ctx, "overview", fmt.Sprintf("%032x", index), true, at); err != nil || !accepted {
			t.Fatalf("seed: accepted=%v err=%v", accepted, err)
		}
	}
	assertAppUITelemetryCapacity(t, db, 3)
	counts, err := db.AppUITelemetrySummary(ctx, now.AddDate(-1, 0, 0), now)
	if err != nil || !reflect.DeepEqual(counts, []AppUITelemetryCount{{FeatureID: "overview", Visits: 1, LegacyOpens: 1}}) {
		t.Fatalf("summary retained expired visits: %+v err=%v", counts, err)
	}
	assertAppUITelemetryCapacity(t, db, 3) // reads exclude expiry without writing
	for _, since := range []time.Time{now.Add(-24 * time.Hour), now.Add(time.Second)} {
		counts, err := db.AppUITelemetrySummary(ctx, since, now)
		if err != nil || counts == nil || len(counts) != 0 {
			t.Fatalf("empty window=%+v err=%v", counts, err)
		}
	}
	if err := db.PurgeAppUITelemetry(ctx, now); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, db, 1)
	if err := db.PurgeAppUITelemetry(ctx, now); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, db, 1)
	if err := db.PurgeAppUITelemetry(ctx, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUITelemetryConcurrentPeersAndPurge(t *testing.T) {
	stores := appUITelemetryStores(t, 4)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	start := make(chan struct{})
	var workers sync.WaitGroup
	var acceptedMu sync.Mutex
	acceptedVisits := make(map[int]bool)
	for index := range 96 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			visit := index % 24
			accepted, err := stores[index%len(stores)].RecordAppUITelemetry(ctx, "gateway.chat",
				fmt.Sprintf("%032x", visit), index >= 24, now)
			if !accepted && appUITelemetryExpectedBusyDrop(stores[index%len(stores)], err) {
				return
			}
			if err != nil || !accepted {
				t.Errorf("concurrent record accepted=%v err=%v", accepted, err)
				return
			}
			acceptedMu.Lock()
			acceptedVisits[visit] = acceptedVisits[visit] || index >= 24
			acceptedMu.Unlock()
		}()
	}
	for index := range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			if err := stores[index%len(stores)].PurgeAppUITelemetry(ctx, now); err != nil && !appUITelemetryExpectedBusyDrop(stores[index%len(stores)], err) {
				t.Errorf("concurrent purge: %v", err)
			}
		}()
	}
	close(start)
	workers.Wait()
	if len(acceptedVisits) == 0 {
		t.Fatal("no concurrent observations were accepted")
	}
	want := AppUITelemetryCount{FeatureID: "gateway.chat", Visits: int64(len(acceptedVisits))}
	for _, legacy := range acceptedVisits {
		if legacy {
			want.LegacyOpens++
		}
	}
	assertAppUITelemetryCapacity(t, stores[0], want.Visits)
	counts, err := stores[0].AppUITelemetrySummary(ctx, now.Add(-time.Hour), now)
	if err != nil || !reflect.DeepEqual(counts, []AppUITelemetryCount{want}) {
		t.Fatalf("concurrent summary=%+v err=%v, want %+v", counts, err, want)
	}
}

func TestAppUITelemetryCapacityAcrossPeersAndExpiry(t *testing.T) {
	stores := appUITelemetryStores(t, 4)
	db := stores[0]
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	existingID := strings.Repeat("f", 32)
	if accepted, err := db.RecordAppUITelemetry(ctx, "overview", existingID, false, now); err != nil || !accepted {
		t.Fatalf("seed: accepted=%v err=%v", accepted, err)
	}
	// Fill real rows to one below the production cap in one portable SQL batch;
	// faking the count would not test that it stays consistent with storage.
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, db.bind(`WITH RECURSIVE numbers(n) AS (
		SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?
	) INSERT INTO app_ui_telemetry_visits (visit_hash, feature_id, first_seen_epoch, legacy_open)
	SELECT substr('0000000000000000000000000000000000000000000000000000000000000000',
		1, 64 - length(CAST(n AS TEXT))) || CAST(n AS TEXT), 'overview', ?, 0 FROM numbers`),
		AppUITelemetryVisitLimit-2, now.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, db.bind(`UPDATE app_ui_telemetry_capacity
		SET live_visits = live_visits + ? WHERE singleton = 1`), AppUITelemetryVisitLimit-2); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, db, AppUITelemetryVisitLimit-1)
	start := make(chan struct{})
	acceptedResults := make(chan bool, 16)
	var workers sync.WaitGroup
	for index := range 16 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			accepted, err := stores[index%len(stores)].RecordAppUITelemetry(ctx, "overview", fmt.Sprintf("%032x", index), false, now)
			if err != nil && !appUITelemetryExpectedBusyDrop(stores[index%len(stores)], err) {
				t.Errorf("capacity race: %v", err)
			}
			acceptedResults <- accepted
		}()
	}
	close(start)
	workers.Wait()
	close(acceptedResults)
	acceptedCount := 0
	for accepted := range acceptedResults {
		if accepted {
			acceptedCount++
		}
	}
	if acceptedCount != 1 {
		t.Fatalf("accepted %d new visits for one remaining slot", acceptedCount)
	}
	assertAppUITelemetryCapacity(t, db, AppUITelemetryVisitLimit)
	for _, peer := range stores {
		assertAppUITelemetryBusyTimeout(t, peer, 10000)
	}
	if accepted, err := db.RecordAppUITelemetry(ctx, "overview", existingID, true, now.Add(time.Hour)); err != nil || !accepted {
		t.Fatalf("Legacy click at capacity accepted=%v err=%v", accepted, err)
	}
	counts, err := db.AppUITelemetrySummary(ctx, now, now.Add(time.Hour))
	if err != nil || !reflect.DeepEqual(counts, []AppUITelemetryCount{{FeatureID: "overview", Visits: AppUITelemetryVisitLimit, LegacyOpens: 1}}) {
		t.Fatalf("at-capacity summary=%+v err=%v", counts, err)
	}
	if accepted, err := db.RecordAppUITelemetry(ctx, "overview", strings.Repeat("e", 32), false,
		now.Add(AppUITelemetryRetentionDays*24*time.Hour)); err != nil || !accepted {
		t.Fatalf("capacity after expiry accepted=%v err=%v", accepted, err)
	}
	assertAppUITelemetryCapacity(t, db, 1)
}
