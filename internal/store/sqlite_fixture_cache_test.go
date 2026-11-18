package store

import "testing"

func TestSQLiteStoreFixtureIndependentCaches(t *testing.T) {
	first, second := openSQLiteStoreForTest(t), openSQLiteStoreForTest(t)
	seedProvider(t, first, "fixture-provider", "https://first.invalid")
	seedProvider(t, second, "fixture-provider", "https://second.invalid")
	for _, item := range []struct {
		db  *SQLStore
		url string
	}{{first, "https://first.invalid"}, {second, "https://second.invalid"}} {
		got, err := item.db.ListProviderConfigs(t.Context())
		if err != nil || len(got) != 1 || got[0].BaseURL != item.url {
			t.Fatal("private fixture provider data or cache leaked")
		}
	}
	// Bypass invalidation to prove the second database has its own warm cache.
	if _, err := second.db.ExecContext(t.Context(), `UPDATE provider_configs SET base_url='https://uncached.invalid'`); err != nil {
		t.Fatal(err)
	}
	seedProvider(t, first, "fixture-provider", "https://edited.invalid")
	got, err := second.ListProviderConfigs(t.Context())
	if err != nil || len(got) != 1 || got[0].BaseURL != "https://second.invalid" {
		t.Fatal("one fixture invalidated another fixture's cache")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if second.LifecycleContext().Err() != nil {
		t.Fatal("closing one fixture canceled another lifecycle")
	}
}
