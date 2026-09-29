package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
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
	for _, test := range []struct {
		action      string
		delayResult bool
	}{
		{action: "update"},
		{action: "delete-recreate"},
		{action: "insert-absent"},
		{action: "update", delayResult: true},
		{action: "delete-recreate", delayResult: true},
		{action: "insert-absent", delayResult: true},
	} {
		name := test.action
		if test.delayResult {
			name += "/delayed-result"
		}
		t.Run(name, func(t *testing.T) {
			action := test.action
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
			before, beforeFound, err := db.GetAdminSetting(ctx, key)
			if err != nil {
				t.Fatal(err)
			}
			assertUnchanged := func(ctx context.Context) {
				t.Helper()
				current, found, err := db.GetAdminSetting(ctx, key)
				if err != nil {
					t.Fatalf("ordinary SELECT blocked: %v", err)
				}
				if found != beforeFound || current != before {
					t.Fatal("writer changed setting while rollback lock was held")
				}
				history, err := db.ListAdminSettingHistory(ctx, key, 1)
				if err != nil || len(history) != 1 || history[0].ID != *stale.ExpectedHistoryID || history[0].HistoryCount != *stale.ExpectedHistoryCount {
					t.Fatalf("writer changed history while rollback lock was held: history=%v error=%v", history, err)
				}
			}
			isBusy := func(err error) bool {
				var sqliteErr *sqlite.Error
				return db.dialect == "sqlite" && errors.As(err, &sqliteErr) && sqliteErr.Code()&0xff == sqlite3.SQLITE_BUSY
			}
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
			completed := make(chan struct{})
			releaseResult := make(chan struct{})
			defer func() {
				select {
				case <-releaseResult:
				default:
					close(releaseResult)
				}
			}()
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
			go func() {
				close(started)
				err := write()
				close(completed)
				if test.delayResult {
					<-releaseResult
				}
				done <- err
			}()
			<-started
			var writeErr error
			resultReceived := false
			select {
			case writeErr = <-done:
				// SQLite read-to-write upgrades can fail immediately instead of
				// waiting behind another writer. Either outcome must prevent a write.
				if !isBusy(writeErr) {
					t.Fatalf("writer escaped rollback lock: %v", writeErr)
				}
				resultReceived = true
			case <-time.After(50 * time.Millisecond):
			}
			readCtx, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			assertUnchanged(readCtx)
			cancel()
			if db.dialect == "sqlite" && test.delayResult {
				// Force the SQLite read-to-write upgrade to finish while the lock
				// is held, but deliver its result only after release. This models
				// a descheduled writer without relying on a fast CI runner.
				select {
				case <-completed:
				case <-time.After(5 * time.Second):
					t.Fatal("SQLite write attempt did not finish under rollback lock")
				}
				assertUnchanged(ctx)
			}
			if db.dialect == "postgres" && test.delayResult {
				// The delivery gate must not hide a PostgreSQL writer that has
				// already finished while its table lock should still be blocking.
				select {
				case <-completed:
					t.Fatal("PostgreSQL writer completed before rollback lock release")
				default:
				}
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			close(releaseResult)
			if !resultReceived {
				select {
				case writeErr = <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("writer did not resume")
				}
			}
			if isBusy(writeErr) {
				// A SQLite failure may be delivered after the observation window
				// (or even after unlock). Its timing does not make it a different
				// outcome. Verify the failed transaction changed nothing, then
				// explicitly start one NEW transaction now that the lock is gone.
				// This is test orchestration, not a production automatic retry.
				assertUnchanged(ctx)
				if err := write(); err != nil {
					t.Fatalf("new writer after rollback lock release failed: %v", err)
				}
			} else if writeErr != nil {
				t.Fatal(writeErr)
			}
			current, found, err := db.GetAdminSetting(ctx, key)
			if err != nil || !found || current.ValueJSON != `"new"` {
				t.Fatalf("writer did not persist after release: setting=%+v found=%v error=%v", current, found, err)
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
