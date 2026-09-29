package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func rollbackRecord(t *testing.T, db *SQLStore, key, value string) AdminSetting {
	t.Helper()
	current, found, err := db.GetAdminSetting(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	version, updatedAt := 0, ""
	if found {
		version, updatedAt = current.Version, current.UpdatedAt
	}
	history, err := db.ListAdminSettingHistory(context.Background(), key, 1)
	if err != nil || len(history) == 0 {
		t.Fatalf("history=%v err=%v", history, err)
	}
	record := settingRecord(key, value, version)
	record.ExpectedUpdatedAt = &updatedAt
	record.ExpectedHistoryID = &history[0].ID
	record.ExpectedHistoryCount = &history[0].HistoryCount
	return record
}

func TestAdminSettingRollbackRejectsPresentAndAbsentABA(t *testing.T) {
	for _, absent := range []bool{false, true} {
		t.Run(map[bool]string{false: "present", true: "absent"}[absent], func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			ctx := context.Background()
			key := "test.rollback-aba"
			if err := db.UpsertAdminSetting(ctx, settingRecord(key, "old", 0), "seed", ""); err != nil {
				t.Fatal(err)
			}
			if absent {
				if err := db.DeleteAdminSetting(ctx, key, "seed", ""); err != nil {
					t.Fatal(err)
				}
			}
			stale := rollbackRecord(t, db, key, "obsolete rollback")
			if !absent {
				if err := db.DeleteAdminSetting(ctx, key, "writer", ""); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.UpsertAdminSetting(ctx, settingRecord(key, "new", 0), "writer", ""); err != nil {
				t.Fatal(err)
			}
			if absent {
				if err := db.DeleteAdminSetting(ctx, key, "writer", ""); err != nil {
					t.Fatal(err)
				}
			}
			before, _, _ := db.GetAdminSetting(ctx, key)
			history, _ := db.ListAdminSettingHistory(ctx, key, 20)
			if err := db.UpsertAdminSetting(ctx, stale, "rollback", "stale"); !errors.Is(err, ErrAdminSettingConflict) {
				t.Fatalf("stale rollback error=%v", err)
			}
			after, _, _ := db.GetAdminSetting(ctx, key)
			afterHistory, _ := db.ListAdminSettingHistory(ctx, key, 20)
			if before.ValueJSON != after.ValueJSON || before.Version != after.Version || before.UpdatedAt != after.UpdatedAt || len(history) != len(afterHistory) {
				t.Fatal("rejected rollback changed setting/history")
			}
		})
	}
}

func TestAdminSettingRollbackRejectsAbsentABAWithClockSkew(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	key := "test.rollback-clock-skew"
	if err := db.UpsertAdminSetting(ctx, settingRecord(key, "reviewed", 0), "seed", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteAdminSetting(ctx, key, "seed", ""); err != nil {
		t.Fatal(err)
	}
	stale := rollbackRecord(t, db, key, "obsolete rollback")
	if err := db.UpsertAdminSetting(ctx, settingRecord(key, "new", 0), "clock-skew", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteAdminSetting(ctx, key, "clock-skew", ""); err != nil {
		t.Fatal(err)
	}
	// A writer on a slow-clock pod appends history older than the reviewed row.
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE admin_setting_history SET changed_at = ? WHERE key = ? AND changed_by = ?`), "2000-01-01T00:00:00Z", key, "clock-skew"); err != nil {
		t.Fatal(err)
	}
	history, err := db.ListAdminSettingHistory(ctx, key, 1)
	if err != nil || len(history) != 1 || history[0].ID != *stale.ExpectedHistoryID {
		t.Fatalf("clock-skew fixture did not preserve reviewed ID: history=%v error=%v", history, err)
	}
	if err := db.UpsertAdminSetting(ctx, stale, "rollback", "stale"); !errors.Is(err, ErrAdminSettingConflict) {
		t.Fatalf("clock-skewed ABA must conflict: %v", err)
	}
	if _, found, err := db.GetAdminSetting(ctx, key); err != nil || found {
		t.Fatalf("rejected clock-skewed rollback recreated override: found=%v error=%v", found, err)
	}
	history, err = db.ListAdminSettingHistory(ctx, key, 1)
	if err != nil || len(history) != 1 || history[0].HistoryCount != 4 {
		t.Fatalf("rejected rollback changed history: history=%v error=%v", history, err)
	}
}

func TestAdminSettingRollbackHistoryCountPrecedesLimitAndPartitionsKeys(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	for _, key := range []string{"test.history-a", "test.history-b"} {
		writes := 3
		if key == "test.history-b" {
			writes = 2
		}
		for version := 0; version < writes; version++ {
			if err := db.UpsertAdminSetting(ctx, settingRecord(key, "value", version), "writer", ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	limited, err := db.ListAdminSettingHistory(ctx, "test.history-a", 1)
	if err != nil || len(limited) != 1 || limited[0].HistoryCount != 3 {
		t.Fatalf("limited history must include whole-key count: %+v error=%v", limited, err)
	}
	all, err := db.ListAdminSettingHistory(ctx, "", 10)
	if err != nil || len(all) != 5 {
		t.Fatalf("all history=%v error=%v", all, err)
	}
	for _, row := range all {
		want := int64(3)
		if row.Key == "test.history-b" {
			want = 2
		}
		if row.HistoryCount != want {
			t.Fatalf("count is not partitioned by key: %+v want=%d", row, want)
		}
	}
}

func TestAdminSettingRollbackLockBlocksWritersNotReaders(t *testing.T) {
	for _, action := range []string{"update", "delete-recreate", "insert-absent"} {
		t.Run(action, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(5)
			ctx := context.Background()
			key := "test.rollback-lock"
			if err := db.UpsertAdminSetting(ctx, settingRecord(key, "old", 0), "seed", ""); err != nil {
				t.Fatal(err)
			}
			if action == "insert-absent" {
				if err := db.DeleteAdminSetting(ctx, key, "seed", ""); err != nil {
					t.Fatal(err)
				}
			}
			stale := rollbackRecord(t, db, key, "old rollback")
			tx, err := db.db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			if err := db.lockAdminSettingsRollbackTx(ctx, tx); err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			done := make(chan error, 1)
			write := func() error {
				if action == "delete-recreate" {
					if err := db.DeleteAdminSetting(ctx, key, "writer", ""); err != nil {
						return err
					}
				}
				version := 0
				if action == "update" {
					version = 1
				}
				return db.UpsertAdminSetting(ctx, settingRecord(key, "new", version), "writer", "")
			}
			go func() { close(started); done <- write() }()
			<-started
			busy := false
			select {
			case err := <-done:
				// SQLite read-to-write upgrades can fail immediately instead of
				// waiting behind another writer. Either outcome must prevent a write.
				if db.dialect != "sqlite" || err == nil || !strings.Contains(err.Error(), "SQLITE_BUSY") {
					t.Fatalf("writer escaped rollback lock: %v", err)
				}
				busy = true
			case <-time.After(50 * time.Millisecond):
			}
			readCtx, cancel := context.WithTimeout(ctx, time.Second)
			_, _, err = db.GetAdminSetting(readCtx, key)
			cancel()
			if err != nil {
				t.Fatalf("ordinary SELECT blocked: %v", err)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if busy {
				done <- write()
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("writer did not resume")
			}
			if err := db.UpsertAdminSetting(ctx, stale, "rollback", "stale"); !errors.Is(err, ErrAdminSettingConflict) {
				t.Fatalf("changed snapshot accepted: %v", err)
			}
		})
	}
}

func TestAdminSettingRollbackCanceledLockNeverPersists(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(5)
	ctx := context.Background()
	key := "test.rollback-cancel"
	if err := db.UpsertAdminSetting(ctx, settingRecord(key, "old", 0), "seed", ""); err != nil {
		t.Fatal(err)
	}
	record := rollbackRecord(t, db, key, "must not persist")
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := db.lockAdminSettingsRollbackTx(ctx, tx); err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- db.UpsertAdminSetting(canceled, record, "rollback", "canceled") }()
	<-canceled.Done()
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled rollback succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled rollback did not finish after lock release")
	}
	current, _, _ := db.GetAdminSetting(ctx, key)
	history, _ := db.ListAdminSettingHistory(ctx, key, 10)
	if current.ValueJSON != `"old"` || current.Version != 1 || len(history) != 1 {
		t.Fatalf("canceled rollback persisted: %+v history=%d", current, len(history))
	}
}
