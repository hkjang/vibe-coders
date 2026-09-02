package store

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestOIDCFlowStateRoundtrip(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	now := time.Now()
	if err := db.SaveOIDCFlowState(ctx, "state1", "nonce1", "verifier1", "/app/overview", now); err != nil {
		t.Fatal(err)
	}
	nonce, verifier, returnTo, found, err := db.TakeOIDCFlowState(ctx, "state1")
	if err != nil || !found || nonce != "nonce1" || verifier != "verifier1" || returnTo != "/app/overview" {
		t.Fatalf("take = (%q,%q,%q,%v,%v)", nonce, verifier, returnTo, found, err)
	}
	// Single-use: a second take must miss.
	if _, _, _, found, _ := db.TakeOIDCFlowState(ctx, "state1"); found {
		t.Fatal("flow state should be single-use (consumed on first take)")
	}
	// Unknown state.
	if _, _, _, found, _ := db.TakeOIDCFlowState(ctx, "nope"); found {
		t.Fatal("unknown state should not be found")
	}
	// Expired (created 11m ago) → not found.
	if err := db.SaveOIDCFlowState(ctx, "old", "n", "v", "/admin", now.Add(-11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, _, found, _ := db.TakeOIDCFlowState(ctx, "old"); found {
		t.Fatal("expired flow state should not be found")
	}
}

func TestOIDCFlowStateConcurrentTakeHasSingleWinner(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	if err := db.SaveOIDCFlowState(ctx, "concurrent", "nonce", "verifier", "/app/", time.Now()); err != nil {
		t.Fatal(err)
	}

	type takeResult struct {
		nonce, verifier, returnTo string
		found                     bool
		err                       error
	}
	const consumers = 8
	start := make(chan struct{})
	results := make(chan takeResult, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			nonce, verifier, returnTo, found, err := db.TakeOIDCFlowState(ctx, "concurrent")
			results <- takeResult{nonce: nonce, verifier: verifier, returnTo: returnTo, found: found, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	winners := 0
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent take failed: %v", result.err)
		}
		if !result.found {
			continue
		}
		winners++
		if result.nonce != "nonce" || result.verifier != "verifier" || result.returnTo != "/app/" {
			t.Fatalf("winner returned unexpected state: %+v", result)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent take winners = %d, want 1", winners)
	}
}
