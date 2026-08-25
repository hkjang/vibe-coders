package store

import (
	"context"
	"testing"
	"time"
)

// A day owns the instant it begins and not the instant it ends.
//
// The rollup rebuild selects a day's surviving requests with `created_at >= dayStart AND
// created_at < dayEnd`. Both halves are load-bearing and neither is reachable through the
// retention worker, whose cutoff falls in the middle of a day: a request logged exactly at
// midnight would either be dropped from the day it belongs to, or counted in that day and
// again in the next, and quota totals would drift by however much traffic lands on the
// boundary.
func TestADayOwnsItsStartAndNotItsEnd(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	now := time.Now().In(seoulZone)
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone).AddDate(0, 0, -1)
	dayEnd := dayStart.Add(24 * time.Hour)

	logUsage(t, db, "at-start", "k1", "10.0.0.1", 10, 1, dayStart)
	logUsage(t, db, "mid-day", "k1", "10.0.0.1", 10, 1, dayStart.Add(12*time.Hour))
	logUsage(t, db, "at-end", "k1", "10.0.0.1", 10, 1, dayEnd)

	// Reconcile as if retention had just run with its cutoff exactly on the day boundary,
	// which is the only way to observe the bounds: the worker's own cutoff is mid-day, and
	// a request at midnight would have been purged before the rebuild ever saw it.
	if err := db.reconcileUsageRollupAfterPurge(ctx, dayStart); err != nil {
		t.Fatal(err)
	}

	// The rebuild is one statement per scope, so each has its own copy of the bounds and
	// each has to be checked. Asserting only one of them leaves the others free to drift.
	dayRequests := func(scope, value, day string) int64 {
		t.Helper()
		var requests int64
		if err := db.db.QueryRowContext(ctx, db.bind(
			`SELECT COALESCE(SUM(requests),0) FROM usage_rollup
			 WHERE scope = ? AND scope_value = ? AND day = ?`),
			scope, value, day).Scan(&requests); err != nil {
			t.Fatal(err)
		}
		return requests
	}

	for _, scope := range []struct{ scope, value string }{
		{"global", "*"}, {"api_key", "k1"}, {"ip", "10.0.0.1"},
	} {
		if got := dayRequests(scope.scope, scope.value, kstDay(dayStart)); got != 2 {
			t.Errorf("%s/%s: the rebuilt day holds %d requests, want 2 — the one at midnight "+
				"belongs to it and the one at the next midnight belongs to the next day",
				scope.scope, scope.value, got)
		}
		// And the request at the next midnight is still counted once, in its own day.
		if got := dayRequests(scope.scope, scope.value, kstDay(dayEnd)); got != 1 {
			t.Errorf("%s/%s: the next day holds %d requests, want 1", scope.scope, scope.value, got)
		}
	}
}

// The sweeper and the readers have to mean the same thing by "expired".
//
// Reads exclude `expires_at > now` and the sweeper deletes `expires_at <= now`, so a
// reservation expiring at exactly that instant is both uncounted and removed. If one side
// were relaxed and the other not, a reservation could keep holding a quota down after it
// was meant to be gone — the failure the reservation table exists to avoid.
func TestTheSweeperAndTheReadersAgreeOnExpiry(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	at := time.Now().UTC().Truncate(time.Second)
	if err := db.ReserveQuota(ctx, QuotaReservation{
		RequestID: "exactly-at", APIKeyID: "k1", ClientIP: "10.0.0.1",
		Tokens: 100, CostKRW: 1, ExpiresAt: at}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReserveQuota(ctx, QuotaReservation{
		RequestID: "just-after", APIKeyID: "k1", ClientIP: "10.0.0.1",
		Tokens: 7, CostKRW: 2, ExpiresAt: at.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}

	// Reading at the instant: the one expiring then does not count, the later one does.
	tokens, _, err := db.ReservedUsage(ctx, "api_key", "k1", at)
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 7 {
		t.Fatalf("ReservedUsage at the expiry instant counted %d tokens, want 7 — a reservation "+
			"expiring exactly now is expired", tokens)
	}
	live, err := db.LiveReservations(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	if got := live["api_key"]["k1"].Tokens; got != 7 {
		t.Fatalf("LiveReservations at the expiry instant counted %d tokens, want 7; it disagrees "+
			"with ReservedUsage about the same instant", got)
	}

	// Sweeping at the same instant removes exactly the one the readers stopped counting.
	removed, err := db.SweepExpiredQuotaReservations(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("the sweep removed %d rows at the expiry instant, want 1: it must remove what "+
			"the readers have stopped counting, and nothing else", removed)
	}
	tokens, _, err = db.ReservedUsage(ctx, "api_key", "k1", at)
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 7 {
		t.Fatalf("after the sweep %d tokens are reserved, want 7 — the sweep took a live one", tokens)
	}
}
