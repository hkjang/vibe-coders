package store

import (
	"context"
	"testing"
	"time"
)

func seedQuota(t *testing.T, db *SQLStore, id, scope, value string, tokenLimit int64, enabled bool) {
	t.Helper()
	if err := db.UpsertQuota(context.Background(), QuotaRecord{
		ID: id, Scope: scope, ScopeValue: value, Period: "daily",
		TokenLimit: tokenLimit, Enabled: enabled, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert %s: %v", id, err)
	}
}

// Changed behind the store's back, so a read that reports the new limit went to the
// database rather than the cache.
func TestActiveQuotasForServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedQuota(t, db, "q1", "api_key", "k1", 1000, true)
	if got, err := db.ActiveQuotasFor(ctx, "api_key", "k1"); err != nil || len(got) != 1 || got[0].TokenLimit != 1000 {
		t.Fatalf("first read: %+v %v", got, err)
	}

	if _, err := db.db.ExecContext(ctx, db.bind(
		`UPDATE quotas SET token_limit = ? WHERE id = ?`), 99, "q1"); err != nil {
		t.Fatal(err)
	}

	got, err := db.ActiveQuotasFor(ctx, "api_key", "k1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].TokenLimit != 1000 {
		t.Fatalf("second read went to the database instead of the cache: %+v", got)
	}
}

// A quota is a limit an operator set. Lowering it, or switching it off, has to apply to
// the very next request — a stale window here is traffic allowed past a limit that has
// already been changed.
func TestQuotaWritesTakeEffectImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedQuota(t, db, "q1", "api_key", "k1", 1000, true)
	if _, err := db.ActiveQuotasFor(ctx, "api_key", "k1"); err != nil { // prime
		t.Fatal(err)
	}

	seedQuota(t, db, "q1", "api_key", "k1", 10, true)
	if got, _ := db.ActiveQuotasFor(ctx, "api_key", "k1"); len(got) != 1 || got[0].TokenLimit != 10 {
		t.Fatalf("a lowered limit was not applied: %+v", got)
	}

	// Disabling has to remove it from the active set, not just change a flag.
	seedQuota(t, db, "q1", "api_key", "k1", 10, false)
	if got, _ := db.ActiveQuotasFor(ctx, "api_key", "k1"); len(got) != 0 {
		t.Fatalf("a disabled quota is still enforced: %+v", got)
	}

	seedQuota(t, db, "q2", "api_key", "k1", 50, true)
	if got, _ := db.ActiveQuotasFor(ctx, "api_key", "k1"); len(got) != 1 || got[0].ID != "q2" {
		t.Fatalf("a new quota is not enforced: %+v", got)
	}
	if err := db.DeleteQuota(ctx, "q2"); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.ActiveQuotasFor(ctx, "api_key", "k1"); len(got) != 0 {
		t.Fatalf("a deleted quota is still enforced: %+v", got)
	}
}

// The whole enabled table is held and filtered in memory, so the filter has to select
// exactly what the query it replaced selected: this scope, this scope value, enabled only.
// A filter that is too loose applies one caller's limit to another.
func TestActiveQuotasForSelectsOnlyTheAskedScope(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedQuota(t, db, "key-1", "api_key", "k1", 10, true)
	seedQuota(t, db, "key-2", "api_key", "k2", 20, true)
	seedQuota(t, db, "team-1", "team", "k1", 30, true) // same value, different scope
	seedQuota(t, db, "global", "global", "*", 40, true)
	seedQuota(t, db, "off", "api_key", "k1", 50, false)

	cases := []struct {
		scope, value string
		wantIDs      []string
	}{
		{"api_key", "k1", []string{"key-1"}},
		{"api_key", "k2", []string{"key-2"}},
		{"team", "k1", []string{"team-1"}},
		{"global", "*", []string{"global"}},
		{"api_key", "nobody", nil},
		{"ip", "1.2.3.4", nil},
	}
	for _, tc := range cases {
		got, err := db.ActiveQuotasFor(ctx, tc.scope, tc.value)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(tc.wantIDs) {
			t.Errorf("%s/%s returned %d quotas, want %d: %+v", tc.scope, tc.value, len(got), len(tc.wantIDs), got)
			continue
		}
		for i, id := range tc.wantIDs {
			if got[i].ID != id {
				t.Errorf("%s/%s returned %q, want %q", tc.scope, tc.value, got[i].ID, id)
			}
		}
	}
}

// The definitions are cached; the usage they are compared against must not be. Caching a
// usage figure would mean a quota that stops counting — traffic allowed past a limit it
// has already crossed.
func TestQuotaUsageIsNotCached(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	since := time.Now().UTC().Add(-time.Hour)
	usage := func() int64 {
		t.Helper()
		_, _, tokens, err := db.UsageSince(ctx, UsageFilter{Scope: "api_key", ScopeValue: "k1", Since: since})
		if err != nil {
			t.Fatal(err)
		}
		return tokens
	}

	seedQuota(t, db, "q1", "api_key", "k1", 1000, true)
	if _, err := db.ActiveQuotasFor(ctx, "api_key", "k1"); err != nil { // warm the definition cache
		t.Fatal(err)
	}
	before := usage()

	insertReq(t, db, "r-usage-1", "k1", 5, 250, time.Now().UTC())
	if after := usage(); after != before+250 {
		t.Fatalf("usage went from %d to %d after logging 250 tokens; it is being served from a cache", before, after)
	}
	insertReq(t, db, "r-usage-2", "k1", 5, 100, time.Now().UTC())
	if after := usage(); after != before+350 {
		t.Fatalf("usage stopped tracking at %d; enforcement would let traffic past the limit", after)
	}
}
