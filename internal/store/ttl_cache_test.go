package store

import (
	"context"
	"testing"
	"time"
)

// The race the expiry alone does not close: a reader queries, a writer commits and
// invalidates, and only then does the reader store what it read. Without the generation
// check the cache would then hold the pre-commit state as if it were current.
func TestALoadThatLosesToAWriteIsNotCached(t *testing.T) {
	var c cachedValue[string]
	now := time.Now()

	gen := c.begin() // the reader is about to query
	c.clear()        // a writer commits and invalidates while it is querying

	if c.putIfCurrent("stale", gen, now) {
		t.Fatal("a load that started before an invalidation was accepted into the cache")
	}
	if _, ok := c.get(now); ok {
		t.Fatal("the cache holds a value after being invalidated")
	}

	// A load that starts after the invalidation is the current one and must be accepted.
	gen = c.begin()
	if !c.putIfCurrent("fresh", gen, now) {
		t.Fatal("a load with the current generation was rejected")
	}
	got, ok := c.get(now)
	if !ok || got != "fresh" {
		t.Fatalf("get returned %q %v", got, ok)
	}
}

func TestCachedValueExpires(t *testing.T) {
	var c cachedValue[int]
	base := time.Now()
	c.putIfCurrent(7, c.begin(), base)

	if got, ok := c.get(base.Add(configCacheTTL - time.Millisecond)); !ok || got != 7 {
		t.Fatalf("value should still be fresh just inside the TTL: %v %v", got, ok)
	}
	if _, ok := c.get(base.Add(configCacheTTL)); ok {
		t.Fatal("value should be stale once the TTL has elapsed")
	}
}

// The same race, through the real store: a policy write that lands while a rule load is in
// flight has to win. Losing it means enforcing a policy the operator already withdrew,
// for as long as the TTL.
func TestAPolicyWriteBeatsAnInFlightRuleLoad(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	seedPolicy(t, db, "p1", "first", "detect", true)
	stale, err := db.loadActivePolicyRules(ctx) // the reader has queried...
	if err != nil {
		t.Fatal(err)
	}
	gen := db.policies.beginLoad()

	seedPolicy(t, db, "p1", "edited", "block", true) // ...the writer commits and invalidates...

	db.policies.storeActiveRules(stale, gen, time.Now()) // ...and only now does the reader store

	got, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "edited" {
		t.Fatalf("the in-flight load overwrote a committed policy change: %v", ruleNames(got))
	}
}
