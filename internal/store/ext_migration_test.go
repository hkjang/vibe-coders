package store

import (
	"context"
	"testing"
	"time"
)

// TestExtKeyRenameMigration verifies the legacy ext_* → key_* rename: the api_keys
// row is renamed (status preserved) and its request_logs are repointed. (api_keys
// has a UNIQUE key_hash, so an ext_/key_ pair for the same hash can never coexist —
// the rename can never collide.)
func TestExtKeyRenameMigration(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	since := time.Now().UTC().Add(-time.Hour)

	// legacy external key + traffic under it
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "ext_abc123def4567", Name: "alice", KeyHash: "abc123def4567hash", Status: "external"}); err != nil {
		t.Fatal(err)
	}
	insertReq(t, db, "r1", "ext_abc123def4567", 10, 100, time.Now().UTC())

	// re-run migrations (rename statements are idempotent and run every Migrate)
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	if _, found, _ := db.GetAPIKey(ctx, "ext_abc123def4567"); found {
		t.Fatal("ext_abc123def4567 should have been renamed away")
	}
	k, found, err := db.GetAPIKey(ctx, "key_abc123def4567")
	if err != nil || !found || k.Status != "external" || k.Name != "alice" {
		t.Fatalf("expected renamed key_abc123def4567 (external/alice), got found=%v %+v", found, k)
	}
	reqs, _, _, err := db.UsageSince(ctx, UsageFilter{Scope: "api_key", ScopeValue: "key_abc123def4567", Since: since})
	if err != nil || reqs != 1 {
		t.Fatalf("expected 1 request repointed to key_abc123def4567, got %d (err %v)", reqs, err)
	}
}
