package store

import (
	"context"
	"testing"
	"time"
)

func TestOIDCFlowStateRoundtrip(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	now := time.Now()
	if err := db.SaveOIDCFlowState(ctx, "state1", "nonce1", "verifier1", now); err != nil {
		t.Fatal(err)
	}
	nonce, verifier, found, err := db.TakeOIDCFlowState(ctx, "state1")
	if err != nil || !found || nonce != "nonce1" || verifier != "verifier1" {
		t.Fatalf("take = (%q,%q,%v,%v)", nonce, verifier, found, err)
	}
	// Single-use: a second take must miss.
	if _, _, found, _ := db.TakeOIDCFlowState(ctx, "state1"); found {
		t.Fatal("flow state should be single-use (consumed on first take)")
	}
	// Unknown state.
	if _, _, found, _ := db.TakeOIDCFlowState(ctx, "nope"); found {
		t.Fatal("unknown state should not be found")
	}
	// Expired (created 11m ago) → not found.
	if err := db.SaveOIDCFlowState(ctx, "old", "n", "v", now.Add(-11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, found, _ := db.TakeOIDCFlowState(ctx, "old"); found {
		t.Fatal("expired flow state should not be found")
	}
}
