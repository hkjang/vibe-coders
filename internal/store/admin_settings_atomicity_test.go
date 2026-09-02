package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

func settingRecord(key, value string, expectedVersion int) AdminSetting {
	encoded, _ := json.Marshal(value)
	version := expectedVersion
	return AdminSetting{
		Key:             key,
		Category:        "test",
		ValueJSON:       string(encoded),
		ValueType:       "string",
		Source:          "admin",
		Version:         expectedVersion,
		ExpectedVersion: &version,
	}
}

func TestAdminSettingExpectedVersionSingleWinner(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertAdminSetting(ctx, AdminSetting{Key: "test.concurrent", Category: "test", ValueJSON: `"initial"`, ValueType: "string"}, "seed", ""); err != nil {
		t.Fatal(err)
	}
	current, found, err := db.GetAdminSetting(ctx, "test.concurrent")
	if err != nil || !found {
		t.Fatalf("load initial setting: found=%v err=%v", found, err)
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, value := range []string{"candidate-a", "candidate-b"} {
		value := value
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- db.UpsertAdminSetting(ctx, settingRecord("test.concurrent", value, current.Version), value, "race")
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	succeeded, conflicted := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrAdminSettingConflict):
			conflicted++
		default:
			t.Fatalf("unexpected concurrent write error: %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("concurrent results: succeeded=%d conflicted=%d, want 1/1", succeeded, conflicted)
	}
	final, _, err := db.GetAdminSetting(ctx, "test.concurrent")
	if err != nil {
		t.Fatal(err)
	}
	if final.Version != current.Version+1 {
		t.Fatalf("final version=%d, want %d", final.Version, current.Version+1)
	}
}

func TestDeleteAdminSettingExpectedVersion(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertAdminSetting(ctx, AdminSetting{Key: "test.delete", Category: "test", ValueJSON: `"v1"`, ValueType: "string"}, "seed", ""); err != nil {
		t.Fatal(err)
	}
	v1, _, _ := db.GetAdminSetting(ctx, "test.delete")
	if err := db.UpsertAdminSetting(ctx, settingRecord("test.delete", "v2", v1.Version), "writer", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteAdminSetting(ctx, "test.delete", "deleter", "stale", v1.Version); !errors.Is(err, ErrAdminSettingConflict) {
		t.Fatalf("stale delete error=%v, want ErrAdminSettingConflict", err)
	}
	if _, found, err := db.GetAdminSetting(ctx, "test.delete"); err != nil || !found {
		t.Fatalf("stale delete removed the setting: found=%v err=%v", found, err)
	}
	v2, _, _ := db.GetAdminSetting(ctx, "test.delete")
	if err := db.DeleteAdminSetting(ctx, "test.delete", "deleter", "current", v2.Version); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.GetAdminSetting(ctx, "test.delete"); err != nil || found {
		t.Fatalf("current-version delete result: found=%v err=%v", found, err)
	}
}
