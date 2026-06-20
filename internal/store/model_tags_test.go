package store

import (
	"context"
	"testing"
)

func TestModelUsageTagStore(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertModelUsageTag(ctx, ModelUsageTag{Model: "claude-opus-4-8", GoodFor: "code_review,summary", AvoidFor: "bulk_cheap", RiskNote: "비쌈"}); err != nil {
		t.Fatal(err)
	}
	// Upsert again updates in place (no duplicate row).
	if err := db.UpsertModelUsageTag(ctx, ModelUsageTag{Model: "claude-opus-4-8", GoodFor: "code_review", AvoidFor: ""}); err != nil {
		t.Fatal(err)
	}
	tags, err := db.ListModelUsageTags(ctx)
	if err != nil || len(tags) != 1 {
		t.Fatalf("list mismatch len=%d err=%v", len(tags), err)
	}
	if tags[0].GoodFor != "code_review" {
		t.Errorf("upsert should update good_for, got %q", tags[0].GoodFor)
	}
	if err := db.DeleteModelUsageTag(ctx, "claude-opus-4-8"); err != nil {
		t.Fatal(err)
	}
	if tags, _ := db.ListModelUsageTags(ctx); len(tags) != 0 {
		t.Error("tag should be deleted")
	}
}
