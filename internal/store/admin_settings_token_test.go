package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestAdminSettingsChangeToken(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "settings.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	empty, err := db.AdminSettingsChangeToken(ctx)
	if err != nil {
		t.Fatal(err)
	}

	set := AdminSetting{Key: "text2sql.enabled", Category: "text2sql", ValueJSON: "true", ValueType: "bool"}
	if err := db.UpsertAdminSetting(ctx, set, "admin@x", "enable"); err != nil {
		t.Fatal(err)
	}
	afterUpsert, _ := db.AdminSettingsChangeToken(ctx)
	if afterUpsert == empty {
		t.Fatal("token must change after an upsert")
	}

	// Re-upserting the same key bumps version → token changes again (a pod must reload).
	set.ValueJSON = "false"
	if err := db.UpsertAdminSetting(ctx, set, "admin@x", "disable"); err != nil {
		t.Fatal(err)
	}
	afterUpdate, _ := db.AdminSettingsChangeToken(ctx)
	if afterUpdate == afterUpsert {
		t.Fatal("token must change after updating an existing key (version bump)")
	}

	// Deleting changes COUNT → token changes (covers cross-pod delete propagation).
	if err := db.DeleteAdminSetting(ctx, "text2sql.enabled", "admin@x", "remove"); err != nil {
		t.Fatal(err)
	}
	afterDelete, _ := db.AdminSettingsChangeToken(ctx)
	if afterDelete == afterUpdate {
		t.Fatal("token must change after a delete")
	}
}
