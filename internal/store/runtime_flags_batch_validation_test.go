package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestRuntimeFlagBatchValidationRollbackAndRepair(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	keys := []string{"test.validated.a", "test.validated.b"}
	before, err := db.SaveRuntimeFlagBatch(t.Context(), []RuntimeFlag{
		{Key: keys[0], Value: "old", UpdatedBy: "original", Note: "keep metadata"},
		{Key: keys[1], Value: "corrupt", UpdatedBy: "original", Note: "keep metadata"},
	}, keys)
	if err != nil {
		t.Fatal(err)
	}
	rejected := errors.New("synthetic snapshot rejection")
	for _, updates := range [][]RuntimeFlag{
		nil,
		{{Key: keys[0], Value: "replacement", UpdatedBy: "new"}},
	} {
		called := false
		snapshot, err := db.SaveRuntimeFlagBatchValidated(t.Context(), updates, keys, func(prospective map[string]RuntimeFlag) error {
			called = true
			if len(updates) > 0 && prospective[keys[0]].Value != "replacement" {
				t.Error("validator did not observe the transaction's provisional write")
			}
			if prospective[keys[1]].Value != "corrupt" {
				t.Error("validator lost an omitted field")
			}
			return rejected
		})
		if !called || !errors.Is(err, rejected) || snapshot != nil {
			t.Fatalf("validation failure returned success: called=%v err=%v", called, err)
		}
		after, err := db.GetRuntimeFlagSnapshot(t.Context(), keys)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatal("validation rejection changed stored values or metadata")
		}
	}
	var validated map[string]RuntimeFlag
	committed, err := db.SaveRuntimeFlagBatchValidated(t.Context(), []RuntimeFlag{{Key: keys[1], Value: "repaired"}}, keys, func(snapshot map[string]RuntimeFlag) error {
		validated = snapshot
		if snapshot[keys[1]].Value != "repaired" || snapshot[keys[0]].Value != "old" {
			return rejected
		}
		return nil
	})
	after, readErr := db.GetRuntimeFlagSnapshot(t.Context(), keys)
	if err != nil || readErr != nil || !reflect.DeepEqual(validated, committed) || !reflect.DeepEqual(committed, after) || !reflect.DeepEqual(before[keys[0]], after[keys[0]]) {
		t.Fatalf("repair did not return its own validated committed snapshot: %v / %v", err, readErr)
	}
}

func TestRuntimeFlagBatchValidationCommitFailureReturnsNoSnapshot(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	key := "test.validated.a"
	// Cancellation after validation must still fail commit and discard its snapshot.
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	called := false
	snapshot, err := db.SaveRuntimeFlagBatchValidated(ctx, []RuntimeFlag{{Key: key, Value: "new"}}, []string{key}, func(map[string]RuntimeFlag) error {
		called = true
		cancel()
		return nil
	})
	if !called || err == nil || snapshot != nil {
		t.Fatal("canceled commit returned a validated but uncommitted success")
	}
	after, err := db.GetRuntimeFlagSnapshot(t.Context(), []string{key})
	if err != nil || len(after) != 0 {
		t.Fatal("canceled commit left an update behind")
	}
}
