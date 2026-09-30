package store

import (
	"context"
	"testing"
	"time"
)

func commitHistoryOrderSetting(t *testing.T, db *SQLStore, key, value string, version int, timestamp string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := db.upsertAdminSettingTx(ctx, tx, settingRecord(key, value, version), "history-order-test", "public values only", timestamp); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// UTC RFC3339Nano omits trailing fractional zeroes. History selection and its
// optimistic guard must agree on chronological order across canonical widths.
// Equal timestamps and wall-clock reversal are deliberately not commit order.
func TestAdminSettingHistoryChronologicalOrder(t *testing.T) {
	for _, tc := range []struct{ name, first, second string }{
		{"canonical_equal_width_control", "2000-01-01T00:00:00.121Z", "2000-01-01T00:00:00.123Z"},
		{"fractional_prefix", "2000-01-01T00:00:00.12Z", "2000-01-01T00:00:00.123Z"},
		{"whole_second_then_fraction", "2000-01-01T00:00:00Z", "2000-01-01T00:00:00.001Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first, err := time.Parse(time.RFC3339Nano, tc.first)
			if err != nil {
				t.Fatal(err)
			}
			second, err := time.Parse(time.RFC3339Nano, tc.second)
			if err != nil || !second.After(first) || first.UTC().Format(time.RFC3339Nano) != tc.first || second.UTC().Format(time.RFC3339Nano) != tc.second {
				t.Fatalf("fixture must be chronological canonical UTC: first=%q second=%q error=%v", tc.first, tc.second, err)
			}
			db := openStoreForTest(t)
			t.Cleanup(func() { _ = db.Close() })
			ctx := context.Background()
			const key = "test.history-chronological"
			const otherKey = "test.history-unrelated"
			commitHistoryOrderSetting(t, db, otherKey, "17", 0, "1999-12-31T23:59:59Z")
			commitHistoryOrderSetting(t, db, key, "50", 0, tc.first)
			commitHistoryOrderSetting(t, db, key, "70", 1, tc.second)
			current, found, err := db.GetAdminSetting(ctx, key)
			if err != nil || !found || current.ValueJSON != `"70"` || current.Version != 2 || current.UpdatedAt != tc.second {
				t.Fatalf("latest write not committed: current=%+v found=%v error=%v", current, found, err)
			}
			var latestID string
			if err := db.db.QueryRowContext(ctx, db.bind(`SELECT id FROM admin_setting_history WHERE key = ? AND new_value_json = ?`), key, `"70"`).Scan(&latestID); err != nil {
				t.Fatal(err)
			}
			for _, query := range []struct {
				name, key string
				limit     int
				wantRows  int
			}{
				{"filtered_all", key, 10, 2},
				{"filtered_limit_one", key, 1, 1},
				{"unfiltered_all", "", 10, 3},
				{"unfiltered_limit_one", "", 1, 1},
			} {
				history, err := db.ListAdminSettingHistory(ctx, query.key, query.limit)
				if err != nil || len(history) != query.wantRows {
					t.Fatalf("%s history rows=%d error=%v", query.name, len(history), err)
				}
				latest := history[0]
				if latest.ID != latestID || latest.Key != key || latest.OldValueJSON != `"50"` || latest.NewValueJSON != `"70"` || latest.ChangedAt != tc.second || latest.HistoryCount != 2 {
					t.Errorf("%s selected wrong latest row: %+v; want second write70 with old50 and per-key count2", query.name, latest)
				}
				for _, row := range history {
					wantCount := int64(2)
					if row.Key == otherKey {
						wantCount = 1
					}
					if row.HistoryCount != wantCount {
						t.Errorf("%s row key=%s count=%d want=%d", query.name, row.Key, row.HistoryCount, wantCount)
					}
				}
			}
			// Exercise the separate latest-ID query inside the actual writer too;
			// correcting only ListAdminSettingHistory would leave this guard broken.
			count := int64(2)
			rollback := settingRecord(key, "50", 2)
			rollback.ExpectedUpdatedAt = &current.UpdatedAt
			rollback.ExpectedHistoryID = &latestID
			rollback.ExpectedHistoryCount = &count
			if err := db.UpsertAdminSetting(ctx, rollback, "history-order-test", "restore public50"); err != nil {
				t.Errorf("chronologically latest history guard rejected: %v", err)
				after, _, getErr := db.GetAdminSetting(ctx, key)
				history, listErr := db.ListAdminSettingHistory(ctx, key, 10)
				if getErr != nil || listErr != nil || after.ValueJSON != current.ValueJSON || after.Version != current.Version || after.UpdatedAt != current.UpdatedAt || len(history) != 2 {
					t.Fatalf("rejected guard changed state: current=%+v rows=%d errors=%v/%v", after, len(history), getErr, listErr)
				}
				return
			}
			after, _, err := db.GetAdminSetting(ctx, key)
			if err != nil || after.ValueJSON != `"50"` || after.Version != 3 {
				t.Fatalf("rollback not persisted: current=%+v error=%v", after, err)
			}
			history, err := db.ListAdminSettingHistory(ctx, key, 1)
			if err != nil || len(history) != 1 || history[0].OldValueJSON != `"70"` || history[0].NewValueJSON != `"50"` || history[0].HistoryCount != 3 {
				t.Fatalf("committed rollback history=%v error=%v", history, err)
			}
			other, found, err := db.GetAdminSetting(ctx, otherKey)
			if err != nil || !found || other.ValueJSON != `"17"` || other.Version != 1 {
				t.Fatalf("unrelated setting changed: current=%+v found=%v error=%v", other, found, err)
			}
		})
	}
}
