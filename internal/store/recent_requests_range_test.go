package store

import (
	"context"
	"testing"
	"time"
)

// TestRecentRequestsFromToRange verifies the created_at from/to bounds on RecentRequests.
// created_at is stored in UTC; the handler is responsible for converting local (KST) input
// to the absolute instants passed here.
func TestRecentRequestsFromToRange(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Three requests one day apart (UTC).
	times := map[string]time.Time{
		"old": time.Date(2026, 7, 1, 3, 0, 0, 0, time.UTC),
		"mid": time.Date(2026, 7, 15, 3, 0, 0, 0, time.UTC),
		"new": time.Date(2026, 7, 28, 3, 0, 0, 0, time.UTC),
	}
	for id, ts := range times {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Provider: "openai", StatusCode: 200, CreatedAt: ts},
		}); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}

	ids := func(filter RequestFilter) []string {
		reqs, err := db.RecentRequests(ctx, filter)
		if err != nil {
			t.Fatalf("RecentRequests: %v", err)
		}
		out := make([]string, len(reqs))
		for i, r := range reqs {
			out[i] = r.ID
		}
		return out
	}

	// From only: excludes "old".
	if got := ids(RequestFilter{From: time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)}); len(got) != 2 {
		t.Fatalf("From-only got %v, want mid+new", got)
	}
	// To only: excludes "new".
	if got := ids(RequestFilter{To: time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)}); len(got) != 2 {
		t.Fatalf("To-only got %v, want old+mid", got)
	}
	// Both: only "mid" (results are ordered created_at DESC).
	got := ids(RequestFilter{
		From: time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC),
	})
	if len(got) != 1 || got[0] != "mid" {
		t.Fatalf("From+To got %v, want [mid]", got)
	}

	// KST boundary: the "new" request at 2026-07-28T03:00Z is 2026-07-28T12:00 KST.
	// A search "to" the end of 2026-07-27 in KST (== 2026-07-27T15:00Z boundary passed
	// as the absolute instant) must exclude it.
	kst := time.FixedZone("KST", 9*3600)
	endOf27KST := time.Date(2026, 7, 28, 0, 0, 0, 0, kst).Add(-time.Nanosecond) // last instant of Jul 27 KST
	if got := ids(RequestFilter{To: endOf27KST}); len(got) != 2 {
		t.Fatalf("KST end-of-27 got %v, want old+mid (new excluded)", got)
	}
}
