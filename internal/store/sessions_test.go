package store

import (
	"context"
	"testing"
	"time"
)

func TestInferredSessionStoreRoundTripAndExpiry(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := InferredSessionRecord{
		IdentityHash: "ident_abc",
		SessionID:    "sess_old",
		LastSeen:     now.Add(-10 * time.Minute),
		CreatedAt:    now.Add(-10 * time.Minute),
		UpdatedAt:    now.Add(-10 * time.Minute),
	}
	if err := db.UpsertInferredSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.InferredSessionByIdentity(ctx, rec.IdentityHash)
	if err != nil || !found {
		t.Fatalf("session lookup found=%v err=%v", found, err)
	}
	if got.SessionID != "sess_old" || got.IdentityHash != rec.IdentityHash {
		t.Fatalf("unexpected session record: %+v", got)
	}

	rec.SessionID = "sess_new"
	rec.LastSeen = now
	rec.UpdatedAt = now
	if err := db.UpsertInferredSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	got, found, err = db.InferredSessionByIdentity(ctx, rec.IdentityHash)
	if err != nil || !found || got.SessionID != "sess_new" {
		t.Fatalf("session update failed found=%v err=%v got=%+v", found, err, got)
	}

	deleted, err := db.DeleteExpiredInferredSessions(ctx, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("expected one expired session deleted, got %d", deleted)
	}
	if _, found, err := db.InferredSessionByIdentity(ctx, rec.IdentityHash); err != nil || found {
		t.Fatalf("session should be deleted found=%v err=%v", found, err)
	}
}
