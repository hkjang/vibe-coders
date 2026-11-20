package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func diagnosticFixture() AppUIDiagnostic {
	return AppUIDiagnostic{FeatureID: "overview", Kind: "api_error", UIVersion: "v0.86.180", Endpoint: "/admin/requests/{id}/io", Method: "GET", Status: 503, RequestID: "trace_" + strings.Repeat("a", 32), Failure: "http"}
}

func assertDiagnosticCapacity(t *testing.T, db *SQLStore, want int64) {
	t.Helper()
	var actual, reserved int64
	if err := db.db.QueryRow(`SELECT COUNT(*) FROM app_ui_diagnostics`).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if err := db.db.QueryRow(`SELECT live_diagnostics FROM app_ui_telemetry_capacity WHERE singleton=1`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if actual != want || reserved != want {
		t.Fatalf("rows=%d reserved=%d want=%d", actual, reserved, want)
	}
}

func TestAppUIDiagnosticsReplayScopeAndPrivacy(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Second)
	event := diagnosticFixture()
	nonce := strings.Repeat("a", 32)
	for _, at := range []time.Time{now, now.Add(time.Hour)} {
		if ok, err := db.RecordAppUIDiagnostic(ctx, nonce, event, at); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}
	changed := event
	changed.Status = 500
	if _, err := db.RecordAppUIDiagnostic(ctx, nonce, changed, now); !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatal(err)
	}
	changed = event
	changed.FeatureID = "gateway.providers"
	if _, err := db.RecordAppUIDiagnostic(ctx, nonce, changed, now); !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatal(err)
	}
	if ok, err := db.RecordAppUIDiagnostic(ctx, strings.Repeat("b", 32), changed, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	out, err := db.AppUIDiagnosticsSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || out.Total != 1 || len(out.Groups) != 1 || out.Groups[0].Events != 1 || len(out.Recent) != 1 || out.Recent[0].ReceivedAt != now.Format(time.RFC3339) {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	if out.Groups[0].RequestID != "" || out.Recent[0].RequestID != event.RequestID {
		t.Fatal("request IDs belong only in bounded recent correlations")
	}
	assertDiagnosticCapacity(t, db, 2)
	// The common retention loop purges diagnostics even if there are no visits.
	if err := db.PurgeAppUITelemetry(ctx, now.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertDiagnosticCapacity(t, db, 0)
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUIDiagnosticsValidationAndOutOfBandLabels(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now := time.Now().UTC()
	event := diagnosticFixture()
	for _, mutate := range []func(*AppUIDiagnostic){func(d *AppUIDiagnostic) { d.UIVersion = "private-branch" }, func(d *AppUIDiagnostic) { d.RequestID = "private-user" }, func(d *AppUIDiagnostic) { d.Endpoint = "/admin/providers?id=private" }, func(d *AppUIDiagnostic) { d.Failure = "private-message" }, func(d *AppUIDiagnostic) { d.Status = 200 }, func(d *AppUIDiagnostic) { d.Boundary = "root" }} {
		bad := event
		mutate(&bad)
		if _, err := db.RecordAppUIDiagnostic(t.Context(), strings.Repeat("a", 32), bad, now); !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatal(bad, err)
		}
	}
	if ok, err := db.RecordAppUIDiagnostic(t.Context(), strings.Repeat("a", 32), event, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, err := db.db.Exec(`UPDATE app_ui_diagnostics SET ui_version='private-branch',request_id='private-user'`); err != nil {
		t.Fatal(err)
	}
	out, err := db.AppUIDiagnosticsSummary(t.Context(), now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || len(out.Recent) != 1 || out.Recent[0].UIVersion != "" || out.Recent[0].RequestID != "" {
		t.Fatalf("private output: %+v %v", out, err)
	}
	for _, features := range [][]string{{"overview", "overview"}, {"private/user"}} {
		if _, err := db.AppUIDiagnosticsSummary(t.Context(), now.Add(-time.Hour), now, features); !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatal(err)
		}
	}
}

func TestAppUIDiagnosticsCapacityAcrossPeersAndExpiry(t *testing.T) {
	stores := appUITelemetryStores(t, 4)
	db := stores[0]
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	for _, peer := range stores {
		if peer.dialect == "postgres" {
			peer.db.SetMaxOpenConns(8)
		}
	}
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, db.bind(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?) INSERT INTO app_ui_diagnostics (event_hash,feature_id,kind,received_epoch,failure,boundary) SELECT substr('0000000000000000000000000000000000000000000000000000000000000000',1,64-length(CAST(n AS TEXT))) || CAST(n AS TEXT), 'overview','js_error',?,'error','root' FROM numbers`), AppUIDiagnosticLimit-1, now.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, db.bind(`UPDATE app_ui_telemetry_capacity SET live_diagnostics=? WHERE singleton=1`), AppUIDiagnosticLimit-1); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	assertDiagnosticCapacity(t, db, AppUIDiagnosticLimit-1)
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			peer := stores[i%len(stores)]
			ok, err := peer.RecordAppUIDiagnostic(ctx, fmt.Sprintf("%032x", i+10000), diagnosticFixture(), now)
			if appUITelemetryExpectedBusyDrop(peer, err) {
				return
			}
			if err != nil {
				t.Error(err)
				return
			}
			if ok {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if accepted != 1 {
		t.Fatalf("accepted=%d", accepted)
	}
	assertDiagnosticCapacity(t, db, AppUIDiagnosticLimit)
	// Capacity in this stream cannot consume the independent visit allowance.
	if ok, err := db.RecordAppUITelemetry(ctx, "overview", strings.Repeat("f", 32), false, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := db.RecordAppUIDiagnostic(ctx, strings.Repeat("f", 32), diagnosticFixture(), now.Add(30*24*time.Hour)); err != nil || !ok {
		t.Fatal(ok, err)
	}
	assertDiagnosticCapacity(t, db, 1)
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUIDiagnosticsGroupAndRecentBounds(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now := time.Now().UTC()
	ctx := t.Context()
	for i := range 105 {
		event := diagnosticFixture()
		event.UIVersion = fmt.Sprintf("v0.86.%d", i)
		if ok, err := db.RecordAppUIDiagnostic(ctx, fmt.Sprintf("%032x", i), event, now); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}
	out, err := db.AppUIDiagnosticsSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || out.Total != 105 || out.OtherGroupEvents != 5 || len(out.Groups) != 100 || len(out.Recent) != 20 {
		t.Fatalf("bounded output=%+v err=%v", out, err)
	}
}

func TestAppUIDiagnosticsUpgradePreservesExistingUsage(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := t.Context()
	now := time.Now().UTC()
	if ok, err := db.RecordAppUITelemetryMetrics(ctx, "overview", strings.Repeat("a", 32), true, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(120)}, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, err := db.db.ExecContext(ctx, `DROP TABLE app_ui_diagnostics`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, `ALTER TABLE app_ui_telemetry_capacity DROP COLUMN live_diagnostics`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	usage, err := db.AppUITelemetryUsageSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || len(usage.Features) != 1 || usage.Features[0].Visits != 1 || usage.Features[0].LegacyOpens != 1 || usage.Features[0].LoadTotalMS != 120 {
		t.Fatalf("upgrade lost usage: %+v %v", usage, err)
	}
	assertDiagnosticCapacity(t, db, 0)
	if ok, err := db.RecordAppUIDiagnostic(ctx, strings.Repeat("b", 32), diagnosticFixture(), now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	assertDiagnosticCapacity(t, db, 1)
}
