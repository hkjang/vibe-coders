package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func logProviderRequest(t *testing.T, db *SQLStore, id, provider string, status int, latency int64, when time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), LogRecord{Request: RequestLog{
		ID: id, TraceID: id, APIKeyID: "k1", Endpoint: "/v1/chat/completions",
		Model: "gpt-4.1", Provider: provider, StatusCode: status, LatencyMS: latency, CreatedAt: when,
	}}); err != nil {
		t.Fatalf("insert %s: %v", id, err)
	}
}

func healthFor(t *testing.T, scores []ProviderHealthScore, provider string) ProviderHealthScore {
	t.Helper()
	for _, s := range scores {
		if s.Provider == provider {
			return s
		}
	}
	t.Fatalf("no score for %q in %+v", provider, scores)
	return ProviderHealthScore{}
}

// The routing layer calls this two or three times per request, and its cost grows with how
// much traffic the window holds. Serving repeat calls from the cache is the whole point, so
// a second call must not see requests logged since the first.
func TestProviderHealthWindowServesFromCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	for i := 0; i < 5; i++ {
		logProviderRequest(t, db, fmt.Sprintf("a%d", i), "openai", 200, 100, now.Add(-time.Minute))
	}
	first, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := healthFor(t, first, "openai").Requests; got != 5 {
		t.Fatalf("first computation saw %d requests, want 5", got)
	}

	for i := 0; i < 5; i++ {
		logProviderRequest(t, db, fmt.Sprintf("b%d", i), "openai", 200, 100, now.Add(-time.Minute))
	}
	second, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := healthFor(t, second, "openai").Requests; got != 5 {
		t.Fatalf("the second call recomputed instead of using the cache: saw %d requests", got)
	}

	// The uncached form is what the admin screens use, and it has to stay exact.
	exact, err := db.ProviderHealthScores(ctx, now.Add(-15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := healthFor(t, exact, "openai").Requests; got != 10 {
		t.Fatalf("ProviderHealthScores saw %d requests, want 10; the admin path must not be cached", got)
	}
}

// One slot holds one window. A caller asking for a different one is asking a different
// question, and must not be handed the answer to the previous one.
func TestProviderHealthWindowRecomputesForADifferentWindow(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	logProviderRequest(t, db, "recent", "openai", 200, 100, now.Add(-time.Minute))
	logProviderRequest(t, db, "older", "openai", 200, 100, now.Add(-30*time.Minute))

	short, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := healthFor(t, short, "openai").Requests; got != 1 {
		t.Fatalf("15m window saw %d requests, want 1", got)
	}

	long, err := db.ProviderHealthWindow(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := healthFor(t, long, "openai").Requests; got != 2 {
		t.Fatalf("1h window returned the 15m answer: %d requests, want 2", got)
	}
}

// The cached slice outlives the call, so handing it out directly would let one caller's
// edit change the scores every later routing decision is made from.
func TestProviderHealthWindowReturnsACopy(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	logProviderRequest(t, db, "r1", "openai", 200, 100, time.Now().UTC().Add(-time.Minute))

	// The load path: what the query produced is also what was stored, so editing it must
	// not reach the cache.
	loaded, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for i := range loaded {
		loaded[i].Score = -2
	}
	afterLoad, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range afterLoad {
		if s.Score == -2 {
			t.Fatalf("editing the loaded scores leaked into the cache: %+v", s)
		}
	}

	// The cache path: the same has to hold for what a cache hit hands back, which is what
	// every request after the first receives.
	cached, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for i := range cached {
		cached[i].Score = -1
	}
	again, err := db.ProviderHealthWindow(ctx, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range again {
		if s.Score == -1 {
			t.Fatalf("a caller's edit leaked into the cached scores: %+v", s)
		}
	}
}
