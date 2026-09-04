package store

import (
	"context"
	"testing"
	"time"
)

func TestWaterfallScopedEnforcesRequestAPIKeyTeamBoundary(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	for _, key := range []APIKeyRecord{
		{ID: "waterfall-key-alpha", Name: "alpha", Team: "team-alpha", KeyHash: "waterfall-hash-alpha", Status: "active"},
		{ID: "waterfall-key-beta", Name: "beta", Team: "team-beta", KeyHash: "waterfall-hash-beta", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(id, keyID, sessionID string, offset time.Duration) {
		t.Helper()
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
			ID: id, TraceID: id + "-trace", APIKeyID: keyID, SessionID: sessionID,
			Endpoint: "/v1/chat/completions", Model: "gpt-test", Provider: "provider-test",
			StatusCode: 200, LatencyMS: 10, CreatedAt: base.Add(offset),
		}}); err != nil {
			t.Fatal(err)
		}
	}
	insert("waterfall-alpha", "waterfall-key-alpha", "waterfall-shared", 0)
	insert("waterfall-beta", "waterfall-key-beta", "waterfall-shared", time.Second)
	insert("waterfall-unassigned", "", "waterfall-shared", 2*time.Second)
	insert("waterfall-alpha-no-session", "waterfall-key-alpha", "", 3*time.Second)
	insert("waterfall-beta-no-session", "waterfall-key-beta", "", 4*time.Second)

	unrestricted, err := db.Waterfall(ctx, "waterfall-shared", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if unrestricted.Requests != 3 {
		t.Fatalf("unrestricted wrapper requests = %d, want 3: %+v", unrestricted.Requests, unrestricted.Spans)
	}

	alpha, err := db.WaterfallScoped(ctx, "waterfall-shared", 10, 0, []string{"team-alpha"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if alpha.Requests != 1 || alpha.Spans[0].RequestID != "waterfall-alpha" {
		t.Fatalf("alpha scoped waterfall escaped its team: %+v", alpha.Spans)
	}

	empty, err := db.WaterfallScoped(ctx, "waterfall-shared", 10, 0, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Requests != 0 || len(empty.Spans) != 0 {
		t.Fatalf("empty scoped waterfall must fail closed: %+v", empty.Spans)
	}

	noSession, err := db.WaterfallScoped(ctx, "no-session", 10, 0, []string{"team-alpha"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if noSession.Requests != 1 || noSession.Spans[0].RequestID != "waterfall-alpha-no-session" {
		t.Fatalf("no-session scope escaped alpha team: %+v", noSession.Spans)
	}
}
