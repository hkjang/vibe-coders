package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func actionFixture() AppUIAction {
	return AppUIAction{FeatureID: "overview", Action: "save", Outcome: "success", UIVersion: "v0.86.181"}
}
func assertActionCapacity(t *testing.T, db *SQLStore, want int64) {
	t.Helper()
	var actual, reserved int64
	if err := db.db.QueryRow(`SELECT COUNT(*) FROM app_ui_actions`).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if err := db.db.QueryRow(`SELECT live_actions FROM app_ui_telemetry_capacity WHERE singleton=1`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if actual != want || reserved != want {
		t.Fatalf("rows=%d reserved=%d want=%d", actual, reserved, want)
	}
}

func TestAppUIActionsImmutableReplayScopeAndExpiry(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now, ctx := time.Now().UTC().Truncate(time.Second), t.Context()
	event, nonce := actionFixture(), strings.Repeat("a", 32)
	for _, at := range []time.Time{now, now.Add(time.Hour)} {
		if ok, err := db.RecordAppUIAction(ctx, nonce, event, at); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}
	for _, change := range []func(*AppUIAction){func(a *AppUIAction) { a.Action = "delete" }, func(a *AppUIAction) { a.Outcome = "rejected" }, func(a *AppUIAction) { a.FeatureID = "me.home" }, func(a *AppUIAction) { a.UIVersion = "v0.86.182" }} {
		changed := event
		change(&changed)
		if _, err := db.RecordAppUIAction(ctx, nonce, changed, now); !errors.Is(err, ErrAppUITelemetryVisitConflict) {
			t.Fatal(err)
		}
	}
	event.FeatureID = "me.home"
	if ok, err := db.RecordAppUIAction(ctx, strings.Repeat("b", 32), event, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	out, err := db.AppUIActionsSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || out.Success != 1 || out.Rejected != 0 || out.Unknown != 0 || len(out.Groups) != 1 || out.Other != (AppUIActionCounts{}) {
		t.Fatalf("%+v %v", out, err)
	}
	assertActionCapacity(t, db, 2)
	// Expiry is the original receiving time, not the most recent replay.
	if err := db.PurgeAppUITelemetry(ctx, now.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertActionCapacity(t, db, 0)
	assertDiagnosticCapacity(t, db, 0)
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUIActionsCountsGroupsAndPrivateVersion(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx, now := t.Context(), time.Now().UTC()
	for i := range 105 {
		for j, outcome := range []string{"success", "rejected", "unknown"} {
			event := actionFixture()
			event.Outcome = outcome
			event.UIVersion = fmt.Sprintf("v0.86.%d", i)
			if ok, err := db.RecordAppUIAction(ctx, fmt.Sprintf("%032x", i*3+j), event, now); err != nil || !ok {
				t.Fatal(ok, err)
			}
		}
	}
	out, err := db.AppUIActionsSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || out.AppUIActionCounts != (AppUIActionCounts{105, 105, 105}) || out.Other != (AppUIActionCounts{5, 5, 5}) || len(out.Groups) != 100 {
		t.Fatalf("%+v %v", out, err)
	}
	for _, group := range out.Groups {
		if group.AppUIActionCounts != (AppUIActionCounts{1, 1, 1}) {
			t.Fatal(group)
		}
	}
	if _, err := db.db.Exec(`UPDATE app_ui_actions SET ui_version='private-branch'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.Exec(`UPDATE app_ui_actions SET ui_version='another-private-branch' WHERE outcome='unknown'`); err != nil {
		t.Fatal(err)
	}
	out, err = db.AppUIActionsSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	encoded, _ := json.Marshal(out)
	if err != nil || strings.Contains(string(encoded), "private") || len(out.Groups) != 1 || out.Groups[0].AppUIActionCounts != (AppUIActionCounts{105, 105, 105}) {
		t.Fatalf("%s %v", encoded, err)
	}
	for _, ids := range [][]string{{"overview", "overview"}, {"private/user"}, make([]string, 257)} {
		if _, err := db.AppUIActionsSummary(ctx, now.Add(-time.Hour), now, ids); !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatal(err)
		}
	}
	for _, change := range []func(*AppUIAction){func(a *AppUIAction) { a.Action = "private" }, func(a *AppUIAction) { a.Outcome = "private" }, func(a *AppUIAction) { a.FeatureID = "private/user" }, func(a *AppUIAction) { a.UIVersion = "private" }} {
		event := actionFixture()
		change(&event)
		if _, err := db.RecordAppUIAction(ctx, strings.Repeat("e", 32), event, now); !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatal(err)
		}
	}
}

func TestAppUIActionsCapacityAcrossPeers(t *testing.T) {
	stores := appUITelemetryStores(t, 4)
	db := stores[0]
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Second)
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
	_, err = tx.ExecContext(ctx, db.bind(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?) INSERT INTO app_ui_actions (event_hash,feature_id,action,outcome,received_epoch) SELECT substr('0000000000000000000000000000000000000000000000000000000000000000',1,64-length(CAST(n AS TEXT))) || CAST(n AS TEXT), 'overview','save','success',? FROM numbers`), AppUIActionLimit-1, now.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, db.bind(`UPDATE app_ui_telemetry_capacity SET live_actions=? WHERE singleton=1`), AppUIActionLimit-1); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			peer := stores[i%len(stores)]
			ok, err := peer.RecordAppUIAction(ctx, fmt.Sprintf("%032x", i+10000), actionFixture(), now)
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
	assertActionCapacity(t, db, AppUIActionLimit)
	if ok, err := db.RecordAppUITelemetry(ctx, "overview", strings.Repeat("f", 32), false, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := db.RecordAppUIDiagnostic(ctx, strings.Repeat("f", 32), diagnosticFixture(), now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := db.RecordAppUIAction(ctx, strings.Repeat("f", 32), actionFixture(), now.Add(30*24*time.Hour)); err != nil || !ok {
		t.Fatal(ok, err)
	}
	assertActionCapacity(t, db, 1)
	assertAppUITelemetryCapacity(t, db, 0)
	assertDiagnosticCapacity(t, db, 0)
}

func TestAppUIActionsUpgradePreservesExistingStreams(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx, now := t.Context(), time.Now().UTC()
	if ok, err := db.RecordAppUITelemetry(ctx, "overview", strings.Repeat("a", 32), true, now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := db.RecordAppUIDiagnostic(ctx, strings.Repeat("b", 32), diagnosticFixture(), now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, err := db.db.ExecContext(ctx, `DROP TABLE app_ui_actions`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, `ALTER TABLE app_ui_telemetry_capacity DROP COLUMN live_actions`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	assertActionCapacity(t, db, 0)
	assertDiagnosticCapacity(t, db, 1)
	assertAppUITelemetryCapacity(t, db, 1)
	if ok, err := db.RecordAppUIAction(ctx, strings.Repeat("c", 32), actionFixture(), now); err != nil || !ok {
		t.Fatal(ok, err)
	}
	assertActionCapacity(t, db, 1)
}
