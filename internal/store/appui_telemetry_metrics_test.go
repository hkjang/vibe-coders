package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func telemetryLoad(ms int64) *int64 { return &ms }

func TestAppUITelemetryMetricsSummaryDoesNotExposeOutOfBandVersionLabels(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now := time.Now().UTC()
	for i, raw := range []string{"private-user-a", "private-user-b", ""} {
		id := strings.Repeat(string(rune('a'+i)), 32)
		if ok, err := db.RecordAppUITelemetryMetrics(t.Context(), "overview", id, false, AppUITelemetryMetrics{LoadMS: telemetryLoad(int64(i))}, now); err != nil || !ok {
			t.Fatal(ok, err)
		}
		// Simulate data written outside the validated ingestion API.
		if _, err := db.db.ExecContext(t.Context(), db.bind(`UPDATE app_ui_telemetry_visits SET ui_version = ? WHERE load_ms = ?`), raw, i); err != nil {
			t.Fatal(err)
		}
	}
	out, err := db.AppUITelemetryUsageSummary(t.Context(), now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || len(out.Versions) != 1 || out.Versions[0] != (AppUITelemetryVersionCount{Visits: 3, LoadSamples: 3, LoadTotalMS: 3, LoadMaxMS: 2}) || out.OtherVersionVisits != 0 {
		t.Fatalf("raw labels leaked or unknown groups duplicated: %+v %v", out, err)
	}
}

func TestAppUITelemetryMetricsOrderDuplicatesAndPrivacy(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("a", 32)
	for _, event := range []struct {
		legacy bool
		data   AppUITelemetryMetrics
	}{
		{false, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(123)}},
		{false, AppUITelemetryMetrics{}},
		{false, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(456)}},
		{true, AppUITelemetryMetrics{UIVersion: "v0.86.179"}},
	} {
		ok, err := db.RecordAppUITelemetryMetrics(ctx, "overview", id, event.legacy, event.data, now)
		if err != nil || !ok {
			t.Fatalf("record: %v %v", ok, err)
		}
	}
	if _, err := db.RecordAppUITelemetryMetrics(ctx, "overview", id, false, AppUITelemetryMetrics{UIVersion: "v0.86.180"}, now); !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatalf("cross-release nonce reuse: %v", err)
	}
	if _, err := db.RecordAppUITelemetryMetrics(ctx, "system.settings", id, false, AppUITelemetryMetrics{}, now); !errors.Is(err, ErrAppUITelemetryVisitConflict) {
		t.Fatalf("cross-feature nonce reuse: %v", err)
	}
	out, err := db.AppUITelemetryUsageSummary(ctx, now.Add(-time.Hour), now, []string{"overview"})
	want := AppUITelemetryUsage{
		Features: []AppUITelemetryCount{{FeatureID: "overview", Visits: 1, LegacyOpens: 1, LoadSamples: 1, LoadTotalMS: 123, LoadMaxMS: 123}},
		Versions: []AppUITelemetryVersionCount{{UIVersion: "v0.86.179", Visits: 1, LoadSamples: 1, LoadTotalMS: 123, LoadMaxMS: 123}},
	}
	if err != nil || !reflect.DeepEqual(out, want) {
		t.Fatalf("summary=%+v err=%v want=%+v", out, err, want)
	}
	assertAppUITelemetryCapacity(t, db, 1)
	if err := db.PurgeAppUITelemetry(ctx, now.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertAppUITelemetryCapacity(t, db, 0)
	out, err = db.AppUITelemetryUsageSummary(ctx, now, now.Add(30*24*time.Hour), []string{"overview"})
	if err != nil || len(out.Features) != 0 || len(out.Versions) != 0 || out.OtherVersionVisits != 0 {
		t.Fatalf("expired metric retained: %+v %v", out, err)
	}
}

func TestAppUITelemetryMetricsRejectUnboundedData(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	for _, raw := range []string{"private@example.com", "v1.2.3-user-private", "v1.2.3+private", "v01.2.3", "v1000000.1.2", "v1.2.3\n", "https://private/v1.2.3"} {
		if NormalizeAppUIReleaseVersion(raw) != "" {
			t.Fatalf("unsafe release accepted: %q", raw)
		}
	}
	if NormalizeAppUIReleaseVersion("1.2.3") != "v1.2.3" || NormalizeAppUIReleaseVersion("v0.86.179") != "v0.86.179" {
		t.Fatal("canonical release lost")
	}
	for _, data := range []AppUITelemetryMetrics{
		{UIVersion: "private-build"}, {UIVersion: "1.2.3"},
		{LoadMS: telemetryLoad(-1)}, {LoadMS: telemetryLoad(AppUITelemetryLoadLimitMS + 1)},
	} {
		ok, err := db.RecordAppUITelemetryMetrics(t.Context(), "overview", strings.Repeat("a", 32), false, data, time.Now())
		if ok || !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatalf("invalid metrics accepted: %+v %v", data, err)
		}
	}
	assertAppUITelemetryCapacity(t, db, 0)
}

func TestAppUITelemetryMetricsAuthorizedVersionBoundAndMissingSamples(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	now := time.Now().UTC()
	for i := range 23 {
		feature, version := "overview", fmt.Sprintf("v1.0.%d", i)
		var load *int64
		if i == 0 {
			version, load = "", telemetryLoad(0)
		}
		if i == 22 {
			feature, version, load = "system.settings", "v999.0.0", telemetryLoad(120000)
		}
		ok, err := db.RecordAppUITelemetryMetrics(t.Context(), feature, fmt.Sprintf("%032x", i), false, AppUITelemetryMetrics{UIVersion: version, LoadMS: load}, now)
		if !ok || err != nil {
			t.Fatal(err)
		}
	}
	out, err := db.AppUITelemetryUsageSummary(t.Context(), now.Add(-time.Hour), now, []string{"overview"})
	if err != nil || len(out.Features) != 1 || out.Features[0].Visits != 22 || out.Features[0].LoadSamples != 1 || len(out.Versions) != 20 || out.OtherVersionVisits != 2 {
		t.Fatalf("bounded summary=%+v err=%v", out, err)
	}
	for _, row := range out.Versions {
		if row.UIVersion == "v999.0.0" || row.LoadMaxMS > 0 {
			t.Fatal("unauthorized feature leaked into versions")
		}
	}
	empty, err := db.AppUITelemetryUsageSummary(t.Context(), now.Add(-time.Hour), now, nil)
	if err != nil || len(empty.Features) != 0 || len(empty.Versions) != 0 || empty.OtherVersionVisits != 0 {
		t.Fatalf("empty grants broadened: %+v %v", empty, err)
	}
	for _, features := range [][]string{{"overview", "overview"}, {"private@feature"}, make([]string, 257)} {
		if _, err := db.AppUITelemetryUsageSummary(t.Context(), now, now, features); !errors.Is(err, ErrAppUITelemetryInvalidInput) {
			t.Fatalf("invalid feature projection: %v", err)
		}
	}
}

func TestAppUITelemetryMetricsUpgradeRetainsExistingVisit(t *testing.T) {
	db := appUITelemetryStores(t, 1)[0]
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Second)
	id := strings.Repeat("a", 32)
	if ok, err := db.RecordAppUITelemetry(ctx, "overview", id, true, now); !ok || err != nil {
		t.Fatal(err)
	}
	for _, col := range []string{"ui_version", "load_ms"} {
		if _, err := db.db.ExecContext(ctx, `ALTER TABLE app_ui_telemetry_visits DROP COLUMN `+col); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	out, err := db.AppUITelemetryUsageSummary(ctx, now, now.Add(time.Hour), []string{"overview"})
	if err != nil || len(out.Features) != 1 || out.Features[0].Visits != 1 || out.Features[0].LegacyOpens != 1 || out.Features[0].LoadSamples != 0 || out.Versions[0].UIVersion != "" {
		t.Fatalf("old visit changed during migration: %+v %v", out, err)
	}
	if ok, err := db.RecordAppUITelemetryMetrics(ctx, "overview", id, false, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(99)}, now.Add(time.Hour)); !ok || err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	out, err = db.AppUITelemetryUsageSummary(ctx, now, now, []string{"overview"})
	if err != nil || len(out.Features) != 1 || out.Features[0].LoadTotalMS != 99 || out.Versions[0].UIVersion != "v0.86.179" {
		t.Fatalf("late metadata moved first receipt or was lost: %+v %v", out, err)
	}
	assertAppUITelemetryCapacity(t, db, 1)
}

func TestAppUITelemetryMetricsConcurrentFirstSample(t *testing.T) {
	stores := appUITelemetryStores(t, 3)
	now := time.Now().UTC()
	id := strings.Repeat("a", 32)
	var wg sync.WaitGroup
	for i := range 24 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			db := stores[index%len(stores)]
			_, err := db.RecordAppUITelemetryMetrics(context.Background(), "overview", id, true, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(int64(index + 1))}, now)
			if err != nil && !appUITelemetryExpectedBusyDrop(db, err) {
				t.Errorf("concurrent sample: %v", err)
			}
		}(i)
	}
	wg.Wait()
	out, err := stores[0].AppUITelemetryUsageSummary(t.Context(), now, now, []string{"overview"})
	if err != nil || len(out.Features) != 1 || out.Features[0].Visits != 1 || out.Features[0].LoadSamples != 1 || out.Features[0].LoadTotalMS < 1 || out.Features[0].LoadTotalMS > 24 {
		t.Fatalf("first sample not atomic: %+v %v", out, err)
	}
	want := out
	if ok, err := stores[0].RecordAppUITelemetryMetrics(t.Context(), "overview", id, true, AppUITelemetryMetrics{UIVersion: "v0.86.179", LoadMS: telemetryLoad(999)}, now.Add(time.Minute)); !ok || err != nil {
		t.Fatal(err)
	}
	out, err = stores[0].AppUITelemetryUsageSummary(t.Context(), now, now, []string{"overview"})
	if err != nil || !reflect.DeepEqual(out, want) {
		t.Fatalf("duplicate changed initial sample: %+v %v", out, err)
	}
	assertAppUITelemetryCapacity(t, stores[0], 1)
}
