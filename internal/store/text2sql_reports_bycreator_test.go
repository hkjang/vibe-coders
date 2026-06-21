package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestListText2SQLSavedReportsByCreatedBy(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "rep.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	for _, r := range []Text2SQLSavedReport{
		{ID: "r1", Name: "mine A", CreatedBy: "alice", SchemaName: "dw"},
		{ID: "r2", Name: "bob's", CreatedBy: "bob"},
		{ID: "r3", Name: "mine B", CreatedBy: "alice"},
	} {
		if err := db.UpsertText2SQLSavedReport(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	mine, err := db.ListText2SQLSavedReportsByCreatedBy(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 2 {
		t.Fatalf("expected 2 reports for alice, got %d", len(mine))
	}
	for _, r := range mine {
		if r.CreatedBy != "alice" {
			t.Fatalf("got report owned by %q in alice's list", r.CreatedBy)
		}
	}
	none, _ := db.ListText2SQLSavedReportsByCreatedBy(ctx, "nobody")
	if len(none) != 0 {
		t.Fatalf("expected 0 for unknown creator, got %d", len(none))
	}
}
