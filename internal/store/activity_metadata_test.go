package store

import (
	"fmt"
	"testing"
	"time"
)

func TestActivityMetadataTimestampBoundsAndProjection(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	base := time.Date(2026, 11, 17, 1, 2, 3, 0, time.UTC)
	for index, offset := range []time.Duration{-time.Nanosecond, 0, time.Nanosecond, 120 * time.Millisecond, 123 * time.Millisecond, time.Second} {
		id, at := fmt.Sprintf("activity-%d", index), base.Add(offset)
		if err := db.InsertAdminAudit(t.Context(), AdminAuditLog{ID: id, Action: id, AdminID: "private-actor", BeforeValue: "private-before", AfterValue: "private-after", CreatedAt: at}); err != nil {
			t.Fatal(err)
		}
		if err := db.InsertAlertEvent(t.Context(), AlertEvent{ID: id, RuleName: "private-rule", Metric: id, DeliveryError: "private-error", CreatedAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		from, to time.Time
		want     []string
	}{
		{base, base.Add(time.Second), []string{"activity-4", "activity-3", "activity-2", "activity-1"}},
		{base.Add(time.Nanosecond), base.Add(123 * time.Millisecond), []string{"activity-3", "activity-2"}},
		{base.Add(123 * time.Millisecond), base.Add(time.Second), []string{"activity-4"}},
	} {
		audit, err := db.RecentAdminAuditMetadata(t.Context(), tc.from, tc.to)
		if err != nil || len(audit) != len(tc.want) {
			t.Fatalf("audit bounds: size=%d err=%v", len(audit), err)
		}
		alerts, err := db.RecentAlertEventMetadata(t.Context(), tc.from, tc.to)
		if err != nil || len(alerts) != len(tc.want) {
			t.Fatalf("alert bounds: size=%d err=%v", len(alerts), err)
		}
		for i, want := range tc.want {
			if audit[i].Action != want || alerts[i].Metric != want || !alerts[i].DeliveryFailed || alerts[i].Delivered {
				t.Fatal("timestamp order or delivery projection mismatch")
			}
		}
	}
}

func TestIncidentSignalsReuseClusteringWithoutActorQuery(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	now := time.Date(2026, 11, 17, 3, 30, 0, 0, time.UTC)
	for _, hour := range []int{0, 2, 3} {
		for n := range 5 {
			at := time.Date(2026, 11, 17, hour, 0, 0, n, time.UTC)
			if err := db.InsertLogRecord(t.Context(), LogRecord{Request: RequestLog{ID: fmt.Sprintf("signal-%d-%d", hour, n), Provider: "provider-a", StatusCode: 503, CreatedAt: at}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	signals, err := db.IncidentSignals(t.Context(), now.Add(-4*time.Hour), now)
	if err != nil || len(signals) != 2 || !signals[0].Ongoing || signals[0].Errors5xx != 10 || signals[1].Errors5xx != 5 || signals[0].AffectedUsers != 0 {
		t.Fatalf("clustering mismatch: signals=%+v err=%v", signals, err)
	}
	// A fractional upper bound retains the whole second but excludes later records.
	cutoff := time.Date(2026, 11, 17, 3, 0, 0, 4, time.UTC)
	signals, err = db.IncidentSignals(t.Context(), now.Add(-4*time.Hour), cutoff)
	if err != nil || len(signals) != 2 || signals[0].Ongoing || signals[0].Errors5xx != 5 {
		t.Fatalf("upper boundary must leave the current hour below threshold: %+v %v", signals, err)
	}
}
