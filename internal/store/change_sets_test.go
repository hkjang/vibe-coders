package store

import (
	"context"
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
