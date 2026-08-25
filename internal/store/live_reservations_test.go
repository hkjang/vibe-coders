package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// LiveReservations answers per scope what ReservedUsage answers one scope at a time, and
// the admin usage screen still uses the second. Two ways of computing the same number is
// how the two sums quietly stop matching, so they are held together here.
func TestLiveReservationsAgreesWithReservedUsage(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	for _, k := range []struct{ id, team string }{
		{"k-alpha", "alpha"}, {"k-alpha-2", "alpha"}, {"k-beta", "beta"}, {"k-loose", ""},
	} {
		if err := db.UpsertAPIKey(ctx, APIKeyRecord{
			ID: k.id, Name: k.id, KeyHash: "h-" + k.id, Owner: "o", Team: k.team,
			Status: "active", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}

	keys := []string{"k-alpha", "k-alpha-2", "k-beta", "k-loose", "", "k-vanished"}
	ips := []string{"10.0.0.1", "10.0.0.2", ""}
	for i := 0; i < 18; i++ {
		expires := now.Add(time.Minute)
		if i%6 == 0 {
			expires = now.Add(-time.Minute) // already expired: must count for nothing
		}
		if err := db.ReserveQuota(ctx, QuotaReservation{
			RequestID: fmt.Sprintf("res-%02d", i), APIKeyID: keys[i%len(keys)], ClientIP: ips[i%len(ips)],
			Tokens: int64(10 * (i + 1)), CostKRW: float64(i+1) / 2, ExpiresAt: expires,
		}); err != nil {
			t.Fatal(err)
		}
	}

	live, err := db.LiveReservations(ctx, now)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct{ scope, value string }{
		{"global", "*"},
		{"api_key", "k-alpha"}, {"api_key", "k-loose"}, {"api_key", ""}, {"api_key", "k-nobody"},
		{"ip", "10.0.0.1"}, {"ip", "unknown"}, {"ip", "10.9.9.9"},
		{"team", "alpha"}, {"team", "beta"}, {"team", "unassigned"}, {"team", "nobody"},
	}
	sawNonZero := false
	for _, c := range cases {
		wantTokens, wantCost, err := db.ReservedUsage(ctx, c.scope, c.value, now)
		if err != nil {
			t.Fatalf("%s/%s: %v", c.scope, c.value, err)
		}
		got := live[c.scope][c.value]
		if got.Tokens != wantTokens || !nearlyEqual(got.CostKRW, wantCost) {
			t.Errorf("%s/%s: batched (%d tokens, %.4f krw) vs per-scope (%d, %.4f)",
				c.scope, c.value, got.Tokens, got.CostKRW, wantTokens, wantCost)
		}
		if wantTokens > 0 {
			sawNonZero = true
		}
	}
	if !sawNonZero {
		t.Fatal("every scope compared to zero, so agreement proves nothing")
	}
}

// An expired reservation must not hold a quota down. A gateway that died mid-request would
// otherwise pin its key's limit until somebody noticed.
func TestExpiredReservationsAreNotCounted(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.ReserveQuota(ctx, QuotaReservation{
		RequestID: "dead", APIKeyID: "k1", ClientIP: "10.0.0.1",
		Tokens: 500, CostKRW: 5, ExpiresAt: now.Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReserveQuota(ctx, QuotaReservation{
		RequestID: "alive", APIKeyID: "k1", ClientIP: "10.0.0.1",
		Tokens: 7, CostKRW: 1, ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}

	live, err := db.LiveReservations(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := live["api_key"]["k1"]; got.Tokens != 7 {
		t.Fatalf("an expired reservation is still counted: %d tokens, want 7", got.Tokens)
	}
}
