package store

import (
	"context"
	"testing"
	"time"
)

func TestRequestUserIDAndRecentRequests(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	if _, err := db.db.ExecContext(ctx,
		`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id) VALUES (?,?,?,?,?,?)`,
		"k1", "alice key", "h1", "active", now.AddDate(0, 0, -10).Format(time.RFC3339Nano), "alice"); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "req1", TraceID: "req1", APIKeyID: "k1", Endpoint: "/v1/chat/completions",
			Model: "gpt-4.1", Provider: "openai", StatusCode: 200, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	// Ownership resolves to the key's user.
	owner, err := db.RequestUserID(ctx, "req1")
	if err != nil {
		t.Fatal(err)
	}
	if owner != "alice" {
		t.Fatalf("owner = %q, want alice", owner)
	}
	// Unknown request → empty, no error (gives a clean 404 upstream).
	missing, err := db.RequestUserID(ctx, "nope")
	if err != nil {
		t.Fatalf("unexpected err for unknown request: %v", err)
	}
	if missing != "" {
		t.Fatalf("unknown request owner = %q, want empty", missing)
	}

	// Recent requests for the user.
	reqs, err := db.UserRecentRequests(ctx, "alice", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(reqs) != 1 || reqs[0].ID != "req1" || reqs[0].Model != "gpt-4.1" || reqs[0].Provider != "openai" {
		t.Fatalf("unexpected recent requests: %+v", reqs)
	}
	if other, _ := db.UserRecentRequests(ctx, "bob", 10); len(other) != 0 {
		t.Fatalf("bob should have no requests, got %d", len(other))
	}
}
