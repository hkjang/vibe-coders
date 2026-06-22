package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestWorkAppVersions(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "appver.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	app := WorkApp{ID: "app1", Title: "리뷰 앱", Status: "draft",
		Components: []AppComponent{{Kind: "skill", Ref: "code-review", Label: "리뷰"}}}
	if err := db.CreateWorkApp(ctx, app); err != nil {
		t.Fatal(err)
	}
	got, _, _ := db.GetWorkApp(ctx, "app1")

	// First publish → version 1 + app becomes active.
	v1, err := db.PublishWorkAppVersion(ctx, got, "admin@x", "first release")
	if err != nil || v1 != 1 {
		t.Fatalf("publish v1 = %d err=%v", v1, err)
	}
	after, _, _ := db.GetWorkApp(ctx, "app1")
	if after.Status != "active" {
		t.Fatalf("publish should set status active, got %q", after.Status)
	}
	// Second publish → version 2.
	v2, _ := db.PublishWorkAppVersion(ctx, after, "admin@x", "second")
	if v2 != 2 {
		t.Fatalf("publish v2 = %d, want 2", v2)
	}

	versions, err := db.ListWorkAppVersions(ctx, "app1")
	if err != nil || len(versions) != 2 {
		t.Fatalf("versions = %d err=%v", len(versions), err)
	}
	// Newest first, snapshot preserved.
	if versions[0].Version != 2 || versions[1].Version != 1 {
		t.Fatalf("version order wrong: %+v", versions)
	}
	if len(versions[1].Components) != 1 || versions[1].Components[0].Ref != "code-review" {
		t.Fatalf("v1 snapshot lost components: %+v", versions[1].Components)
	}
	if versions[1].Note != "first release" || versions[1].PublishedBy != "admin@x" {
		t.Fatalf("v1 metadata wrong: %+v", versions[1])
	}
	if other, _ := db.ListWorkAppVersions(ctx, "nope"); len(other) != 0 {
		t.Fatalf("unknown app should have no versions, got %d", len(other))
	}
}
