package store

import (
	"context"
	"testing"
	"time"
)

func seedProvider(t *testing.T, db *SQLStore, name, baseURL string) {
	t.Helper()
	if err := db.UpsertProvider(context.Background(), ProviderConfig{
		Name: name, BaseURL: baseURL, TimeoutMS: 1000, Enabled: true,
		ModelPatterns: "gpt-*", Priority: 100, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert %s: %v", name, err)
	}
}

// The cache has to actually cache. Proving that by timing is flaky, so the row is changed
// behind the store's back — a raw UPDATE that never calls invalidate — and the read is
// expected to still return the old value. A read that reports the new URL went to the
// database, which is exactly what the cache is meant to stop doing.
func TestListProviderConfigsServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedProvider(t, db, "p1", "http://first")
	if got, _ := db.ListProviderConfigs(ctx); len(got) != 1 || got[0].BaseURL != "http://first" {
		t.Fatalf("first read: %+v", got)
	}

	if _, err := db.db.ExecContext(ctx, db.bind(
		`UPDATE provider_configs SET base_url = ? WHERE name = ?`), "http://behind-its-back", "p1"); err != nil {
		t.Fatal(err)
	}

	got, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].BaseURL != "http://first" {
		t.Fatalf("second read went to the database instead of the cache: %+v", got)
	}
}

// An operator editing a provider must see it on the very next request. This is the half
// that a plain TTL cache gets wrong, and the reason writes invalidate explicitly.
func TestProviderWritesAreVisibleImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedProvider(t, db, "p1", "http://first")
	if _, err := db.ListProviderConfigs(ctx); err != nil { // prime the cache
		t.Fatal(err)
	}

	seedProvider(t, db, "p1", "http://edited")
	got, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].BaseURL != "http://edited" {
		t.Fatalf("UpsertProvider did not invalidate the cache: %+v", got)
	}

	seedProvider(t, db, "p2", "http://second")
	if got, _ := db.ListProviderConfigs(ctx); len(got) != 2 {
		t.Fatalf("added provider not visible: %+v", got)
	}

	deleted, err := db.DeleteProvider(ctx, "p2")
	if err != nil || !deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	if got, _ := db.ListProviderConfigs(ctx); len(got) != 1 || got[0].Name != "p1" {
		t.Fatalf("DeleteProvider did not invalidate the cache: %+v", got)
	}
}

// ListProviders is a separate query with a separate cache slot; a write has to drop both,
// and its empty result stays non-nil so JSON handlers keep emitting [] rather than null.
func TestListProvidersCacheTracksWrites(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	first, err := db.ListProviders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first == nil {
		t.Fatal("empty ListProviders returned nil, which marshals as null instead of []")
	}
	again, _ := db.ListProviders(ctx)
	if again == nil {
		t.Fatal("cached empty ListProviders returned nil")
	}

	seedProvider(t, db, "p1", "http://first")
	got, err := db.ListProviders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].BaseURL != "http://first" {
		t.Fatalf("ListProviders cache not invalidated by write: %+v", got)
	}
}

// A caller must not be able to change what later callers see. The cached slice outlives
// the call, so handing it out directly would make one handler's edit everyone's.
func TestListProviderConfigsReturnsACopy(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedProvider(t, db, "p1", "http://first")

	// The load path: whatever the database read produced is also what got stored, so
	// editing it must not reach the cache.
	loaded, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	loaded[0].BaseURL = "http://mutated-after-load"
	if got, _ := db.ListProviderConfigs(ctx); got[0].BaseURL != "http://first" {
		t.Fatalf("mutating the loaded slice leaked into the cache: %q", got[0].BaseURL)
	}

	// The cache path: the same has to hold for a slice handed back by a cache hit,
	// which is the one that gets returned for every request after the first.
	cached, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cached[0].BaseURL = "http://mutated-after-hit"
	if got, _ := db.ListProviderConfigs(ctx); got[0].BaseURL != "http://first" {
		t.Fatalf("mutating a cache hit leaked into the cache: %q", got[0].BaseURL)
	}
}

// Rotation rewrites encrypted_api_key with a raw UPDATE. If the cache survived it, the
// gateway would keep using keys encrypted under the retired cipher and fail to decrypt.
func TestRotationInvalidatesProviderCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: "p1", BaseURL: "http://first", TimeoutMS: 1000, Enabled: true,
		EncryptedAPIKey: "old-cipher", Priority: 100, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.ListProviderConfigs(ctx); got[0].EncryptedAPIKey != "old-cipher" {
		t.Fatalf("seed: %+v", got)
	}

	decrypt := func(s string) (string, error) { return s, nil }
	encrypt := func(s string) (string, error) { return "new-cipher", nil }
	if _, err := db.RotateEncryptedColumns(ctx, decrypt, encrypt); err != nil {
		t.Fatal(err)
	}

	got, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].EncryptedAPIKey != "new-cipher" {
		t.Fatalf("rotation left the pre-rotation key in the cache: %q", got[0].EncryptedAPIKey)
	}
}

// GetProvider is on the hot path too — dialUpstream resolves the chosen provider by name
// on every request. It cannot be served from the routing list, which filters out disabled
// providers, so it has its own cache slot over the whole table.
func TestGetProviderUsesTheCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedProvider(t, db, "p1", "http://first")
	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: "disabled", BaseURL: "http://off", TimeoutMS: 1000, Enabled: false,
		Priority: 100, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	// A disabled provider must still be findable: ListProviderConfigs drops it, and
	// serving GetProvider from that list would make it look deleted.
	if p, found, err := db.GetProvider(ctx, "disabled"); err != nil || !found || p.BaseURL != "http://off" {
		t.Fatalf("disabled provider not returned: %+v %v %v", p, found, err)
	}
	if _, found, _ := db.GetProvider(ctx, "nope"); found {
		t.Fatal("unknown provider reported as found")
	}

	// Changed behind the store's back: a cached read must not see it.
	if _, err := db.db.ExecContext(ctx, db.bind(
		`UPDATE provider_configs SET base_url = ? WHERE name = ?`), "http://behind-its-back", "p1"); err != nil {
		t.Fatal(err)
	}
	if p, _, _ := db.GetProvider(ctx, "p1"); p.BaseURL != "http://first" {
		t.Fatalf("GetProvider went to the database instead of the cache: %q", p.BaseURL)
	}

	// But a write through the store must be visible at once.
	seedProvider(t, db, "p1", "http://edited")
	if p, _, _ := db.GetProvider(ctx, "p1"); p.BaseURL != "http://edited" {
		t.Fatalf("write did not invalidate the GetProvider cache: %q", p.BaseURL)
	}
	if _, err := db.DeleteProvider(ctx, "p1"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetProvider(ctx, "p1"); found {
		t.Fatal("deleted provider still served from the cache")
	}
}
