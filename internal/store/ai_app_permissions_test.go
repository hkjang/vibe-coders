package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestAppPermissions(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "perm.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	if err := db.GrantAppPermission(ctx, AppPermission{ID: "p1", AppID: "app1", SubjectType: "user", SubjectID: "alice", GrantedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := db.GrantAppPermission(ctx, AppPermission{ID: "p2", AppID: "app1", SubjectType: "team", SubjectID: "t1", GrantedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	// Idempotent re-grant (same subject) must not error or duplicate.
	if err := db.GrantAppPermission(ctx, AppPermission{ID: "p3", AppID: "app1", SubjectType: "user", SubjectID: "alice", GrantedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	perms, _ := db.ListAppPermissions(ctx, "app1")
	if len(perms) != 2 {
		t.Fatalf("expected 2 grants (idempotent), got %d", len(perms))
	}

	// Subject matching: user alice OR team t1.
	if ok, _ := db.AppGrantsSubject(ctx, "app1", "alice", "other"); !ok {
		t.Fatal("alice should be granted by user grant")
	}
	if ok, _ := db.AppGrantsSubject(ctx, "app1", "bob", "t1"); !ok {
		t.Fatal("bob should be granted via team t1")
	}
	if ok, _ := db.AppGrantsSubject(ctx, "app1", "bob", "t2"); ok {
		t.Fatal("bob in t2 should NOT be granted")
	}

	// Revoke removes it.
	if err := db.RevokeAppPermission(ctx, "app1", "user", "alice"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := db.AppGrantsSubject(ctx, "app1", "alice", "other"); ok {
		t.Fatal("alice grant should be revoked")
	}
	if perms, _ := db.ListAppPermissions(ctx, "app1"); len(perms) != 1 {
		t.Fatalf("expected 1 grant after revoke, got %d", len(perms))
	}
}
