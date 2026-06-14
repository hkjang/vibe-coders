package store

import (
	"context"
	"testing"
)

func TestText2SQLProfileCRUD(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if _, found, _ := db.GetText2SQLProfile(ctx, "vibe/text2sql-finance"); found {
		t.Fatal("profile should not exist yet")
	}

	if err := db.UpsertText2SQLProfile(ctx, Text2SQLProfile{
		VirtualModel: "vibe/text2sql-finance", Mode: "execute", UpstreamModel: "claude-sonnet-4",
		SummaryModel: "gpt-4.1-mini", SchemaName: "finance", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	got, found, err := db.GetText2SQLProfile(ctx, "vibe/text2sql-finance")
	if err != nil || !found {
		t.Fatalf("expected profile, err=%v found=%v", err, found)
	}
	if got.Mode != "execute" || got.UpstreamModel != "claude-sonnet-4" || got.SchemaName != "finance" {
		t.Errorf("unexpected profile: %+v", got)
	}

	// Upsert overrides.
	if err := db.UpsertText2SQLProfile(ctx, Text2SQLProfile{VirtualModel: "vibe/text2sql-finance", Mode: "preview", UpstreamModel: "gpt-4.1", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	got, _, _ = db.GetText2SQLProfile(ctx, "vibe/text2sql-finance")
	if got.Mode != "preview" || got.UpstreamModel != "gpt-4.1" || got.Enabled {
		t.Errorf("upsert override failed: %+v", got)
	}

	list, _ := db.ListText2SQLProfiles(ctx)
	if len(list) != 1 {
		t.Errorf("expected 1 profile, got %d", len(list))
	}
	if err := db.DeleteText2SQLProfile(ctx, "vibe/text2sql-finance"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetText2SQLProfile(ctx, "vibe/text2sql-finance"); found {
		t.Error("profile should be deleted")
	}
}
