package store

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestRuntimeFlagBatchPreservesOmittedAndReturnsSnapshot(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	keys := []string{"test.flag.a", "test.flag.b"}
	if err := db.SetFlag(t.Context(), RuntimeFlag{Key: keys[1], Value: "keep", Note: "original"}); err != nil {
		t.Fatal(err)
	}
	got, err := db.SaveRuntimeFlagBatch(t.Context(), []RuntimeFlag{{Key: keys[0], Value: "", UpdatedBy: "operator"}}, keys)
	if err != nil || len(got) != 2 || got[keys[0]].Value != "" || got[keys[0]].UpdatedBy != "operator" || got[keys[0]].UpdatedAt.IsZero() || got[keys[1]].Value != "keep" || got[keys[1]].Note != "original" {
		t.Fatalf("batch snapshot=%v error=%v", got, err)
	}
}

func TestRuntimeFlagBatchFailureRollsBackEarlierKeys(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	keys := []string{"test.flag.a", "test.flag.b"}
	for _, key := range keys {
		if err := db.SetFlag(t.Context(), RuntimeFlag{Key: key, Value: "old"}); err != nil {
			t.Fatal(err)
		}
	}
	statement := "CREATE TRIGGER reject_flag_batch BEFORE INSERT ON runtime_flags WHEN NEW.key = 'test.flag.b' AND NEW.value = 'fail' BEGIN SELECT RAISE(FAIL, 'synthetic batch failure'); END"
	if db.dialect == "postgres" {
		statement = "ALTER TABLE runtime_flags ADD CONSTRAINT reject_flag_batch CHECK (key <> 'test.flag.b' OR value <> 'fail')"
	}
	if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
		t.Fatal(err)
	}
	got, err := db.SaveRuntimeFlagBatch(t.Context(), []RuntimeFlag{{Key: keys[0], Value: "new"}, {Key: keys[1], Value: "fail"}}, keys)
	if err == nil || got != nil {
		t.Fatalf("injected database failure returned success snapshot: %v error=%v", got, err)
	}
	after, err := db.GetRuntimeFlagSnapshot(t.Context(), keys)
	if err != nil || after[keys[0]].Value != "old" || after[keys[1]].Value != "old" {
		t.Fatalf("partial batch was stored: %v error=%v", after, err)
	}
}

func TestRuntimeFlagBatchCancellationAndInvalidKeysDoNotWrite(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	key := "test.flag.a"
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for _, input := range []struct {
		ctx   context.Context
		flags []RuntimeFlag
	}{
		{ctx, []RuntimeFlag{{Key: key, Value: "new"}}},
		{t.Context(), []RuntimeFlag{{Key: key, Value: "new"}, {Key: key, Value: "duplicate"}}},
		{t.Context(), []RuntimeFlag{{Key: "out-of-snapshot", Value: "new"}}},
	} {
		if got, err := db.SaveRuntimeFlagBatch(input.ctx, input.flags, []string{key}); err == nil || got != nil {
			t.Fatalf("invalid batch succeeded: %v error=%v", got, err)
		}
	}
	got, err := db.GetRuntimeFlagSnapshot(t.Context(), []string{key, "out-of-snapshot"})
	if err != nil || len(got) != 0 {
		t.Fatalf("invalid batch persisted flags: %v error=%v", got, err)
	}
}

func TestRuntimeFlagBatchConcurrentSnapshotsStayCoherent(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(4)
	keys := []string{"test.flag.a", "test.flag.b"}
	patch := func(value string) []RuntimeFlag {
		return []RuntimeFlag{{Key: keys[0], Value: value}, {Key: keys[1], Value: value}}
	}
	if _, err := db.SaveRuntimeFlagBatch(t.Context(), patch("seed"), keys); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var accepted atomic.Int32
	for _, value := range []string{"writer-a", "writer-b"} {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for range 10 {
				snapshot, err := db.SaveRuntimeFlagBatch(t.Context(), patch(value), keys)
				if err != nil {
					if db.dialect == "sqlite" && strings.Contains(err.Error(), "SQLITE_BUSY") {
						continue
					}
					t.Errorf("writer error: %v", err)
					return
				}
				if len(snapshot) != 2 || snapshot[keys[0]].Value != value || snapshot[keys[1]].Value != value {
					t.Errorf("transaction returned a foreign/partial snapshot: %v", snapshot)
					return
				}
				accepted.Add(1)
			}
		}()
	}
	for range 30 {
		snapshot, err := db.GetRuntimeFlagSnapshot(t.Context(), keys)
		if err != nil || len(snapshot) != 2 || snapshot[keys[0]].Value != snapshot[keys[1]].Value {
			t.Errorf("mixed read snapshot: %v error=%v", snapshot, err)
			break
		}
	}
	workers.Wait()
	final, err := db.GetRuntimeFlagSnapshot(t.Context(), keys)
	if err != nil || accepted.Load() == 0 || len(final) != 2 || final[keys[0]].Value == "seed" || final[keys[0]].Value != final[keys[1]].Value {
		t.Fatalf("no successful coherent concurrent write: accepted=%d snapshot=%v error=%v", accepted.Load(), final, err)
	}
}
