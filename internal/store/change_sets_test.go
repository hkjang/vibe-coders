package store

import (
	"context"
	"errors"
	"testing"
)

func TestChangeSetLifecycleStore(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	cs := ChangeSet{
		ID: "cs1", Title: "Enable cache",
		Items: []ChangeSetItem{{Kind: "setting", Key: "cache.chat_enabled", Value: "true"}},
	}
	if err := db.CreateChangeSet(ctx, cs); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetChangeSet(ctx, "cs1")
	if err != nil || !found || got.Status != "draft" || len(got.Items) != 1 {
		t.Fatalf("get change set mismatch: found=%v status=%s items=%d err=%v", found, got.Status, len(got.Items), err)
	}
	// Transition through approve → apply (capturing prior), then rollback.
	got.Status = "approved"
	got.Reviewer = "admin@x"
	if err := db.UpdateChangeSet(ctx, got); err != nil {
		t.Fatal(err)
	}
	got.Status = "applied"
	got.Prior = []ChangeSetItem{{Kind: "setting", Key: "cache.chat_enabled", Value: "false"}}
	got.AppliedAt = "2026-06-20T00:00:00Z"
	if err := db.UpdateChangeSet(ctx, got); err != nil {
		t.Fatal(err)
	}
	got2, _, _ := db.GetChangeSet(ctx, "cs1")
	if got2.Status != "applied" || got2.Reviewer != "admin@x" || len(got2.Prior) != 1 || got2.Prior[0].Value != "false" {
		t.Fatalf("applied state mismatch: %+v", got2)
	}
	list, err := db.ListChangeSets(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list mismatch len=%d err=%v", len(list), err)
	}
	if err := db.DeleteChangeSet(ctx, "cs1"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetChangeSet(ctx, "cs1"); found {
		t.Error("change set should be deleted")
	}
}

func TestStageChangeSetSettingsIsAtomicAndResumable(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	cs := ChangeSet{
		ID: "cs-atomic", Title: "Atomic settings", Status: "approved",
		Items: []ChangeSetItem{
			{Kind: "setting", Key: "test.a", Value: "next-a"},
			{Kind: "setting", Key: "test.b", Value: "next-b"},
		},
	}
	if err := db.CreateChangeSet(ctx, cs); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAdminSettings(ctx, []AdminSetting{
		{Key: "test.a", Category: "test", ValueJSON: `"old-a"`, ValueType: "string"},
		{Key: "test.b", Category: "test", ValueJSON: `"old-b"`, ValueType: "string"},
	}, "seed", ""); err != nil {
		t.Fatal(err)
	}
	a, _, _ := db.GetAdminSetting(ctx, "test.a")
	b, _, _ := db.GetAdminSetting(ctx, "test.b")

	// Make only the second prepared record stale. The first upsert runs before the conflict,
	// proving the surrounding transaction rolls it and its history row back as well.
	if err := db.UpsertAdminSetting(ctx, settingRecord("test.b", "external-b", b.Version), "external", ""); err != nil {
		t.Fatal(err)
	}
	cs.Status = "apply_pending"
	cs.Prior = []ChangeSetItem{
		{Kind: "setting", Key: "test.a", Value: "old-a"},
		{Kind: "setting", Key: "test.b", Value: "external-b"},
	}
	err := db.StageChangeSetSettings(ctx, cs, "approved", "admin", "apply", []AdminSetting{
		settingRecord("test.a", "next-a", a.Version),
		settingRecord("test.b", "next-b", b.Version),
	})
	if !errors.Is(err, ErrAdminSettingConflict) {
		t.Fatalf("stage with stale sibling error=%v, want ErrAdminSettingConflict", err)
	}
	afterFailure, _, _ := db.GetAdminSetting(ctx, "test.a")
	if afterFailure.Version != a.Version || afterFailure.ValueJSON != a.ValueJSON {
		t.Fatalf("first setting leaked from rolled-back batch: before=%+v after=%+v", a, afterFailure)
	}
	historyA, err := db.ListAdminSettingHistory(ctx, "test.a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(historyA) != 1 {
		t.Fatalf("rolled-back setting history rows=%d, want seed row only", len(historyA))
	}
	storedCS, _, _ := db.GetChangeSet(ctx, cs.ID)
	if storedCS.Status != "approved" || len(storedCS.Prior) != 0 {
		t.Fatalf("pending marker/prior leaked from rolled-back batch: %+v", storedCS)
	}

	// Refresh the stale version and stage successfully. The durable pending marker and prior
	// values are committed together with both settings.
	b, _, _ = db.GetAdminSetting(ctx, "test.b")
	if err := db.StageChangeSetSettings(ctx, cs, "approved", "admin", "apply", []AdminSetting{
		settingRecord("test.a", "next-a", a.Version),
		settingRecord("test.b", "next-b", b.Version),
	}); err != nil {
		t.Fatal(err)
	}
	staged, _, _ := db.GetChangeSet(ctx, cs.ID)
	if staged.Status != "apply_pending" || len(staged.Prior) != 2 {
		t.Fatalf("staged change set=%+v, want apply_pending with prior", staged)
	}
	if err := db.FinalizeChangeSetStatus(ctx, cs.ID, "apply_pending", "applied"); err != nil {
		t.Fatal(err)
	}
	// Finalization is intentionally idempotent for crash/retry recovery.
	if err := db.FinalizeChangeSetStatus(ctx, cs.ID, "apply_pending", "applied"); err != nil {
		t.Fatalf("idempotent finalize: %v", err)
	}
	final, _, _ := db.GetChangeSet(ctx, cs.ID)
	if final.Status != "applied" {
		t.Fatalf("final status=%q, want applied", final.Status)
	}
}
