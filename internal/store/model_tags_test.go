package store

import (
	"context"
	"testing"
)

func TestModelUsageTagStore(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	first := ModelUsageTag{Model: "claude-opus-4-8", GoodFor: "code_review,summary", AvoidFor: "bulk_cheap", RiskNote: "비쌈"}
	if err := db.UpsertModelUsageTag(ctx, &first); err != nil {
		t.Fatal(err)
	}
	if first.UpdatedAt == "" {
		t.Fatal("upsert should populate updated_at on the saved tag")
	}
	// Upsert again updates in place (no duplicate row).
	second := ModelUsageTag{Model: "claude-opus-4-8", GoodFor: "code_review", AvoidFor: ""}
	if err := db.UpsertModelUsageTag(ctx, &second); err != nil {
		t.Fatal(err)
	}
	tags, err := db.ListModelUsageTags(ctx)
	if err != nil || len(tags) != 1 {
		t.Fatalf("list mismatch len=%d err=%v", len(tags), err)
	}
	if tags[0].GoodFor != "code_review" {
		t.Errorf("upsert should update good_for, got %q", tags[0].GoodFor)
	}
	if tags[0].UpdatedAt != second.UpdatedAt {
		t.Errorf("persisted updated_at = %q, want returned %q", tags[0].UpdatedAt, second.UpdatedAt)
	}
	if err := db.DeleteModelUsageTag(ctx, "claude-opus-4-8"); err != nil {
		t.Fatal(err)
	}
	if tags, _ := db.ListModelUsageTags(ctx); len(tags) != 0 {
		t.Error("tag should be deleted")
	}
}
