package store

import (
	"context"
	"testing"
)

func TestAdminSettingsChangeToken(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

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
