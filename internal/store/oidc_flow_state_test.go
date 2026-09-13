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
	if err := db.SaveOIDCFlowState(ctx, "state1", OIDCFlowState{Nonce: "nonce1", Verifier: "verifier1", ReturnTo: "/app/overview", Silent: true}, now); err != nil {
		t.Fatal(err)
	}
	fs, found, err := db.TakeOIDCFlowState(ctx, "state1")
	if err != nil || !found || fs.Nonce != "nonce1" || fs.Verifier != "verifier1" || fs.ReturnTo != "/app/overview" || !fs.Silent {
		t.Fatalf("take = (%+v,%v,%v)", fs, found, err)
	}
	// Single-use: a second take must miss.
	if _, found, _ := db.TakeOIDCFlowState(ctx, "state1"); found {
		t.Fatal("flow state should be single-use (consumed on first take)")
	}
	// Unknown state.
	if _, found, _ := db.TakeOIDCFlowState(ctx, "nope"); found {
		t.Fatal("unknown state should not be found")
	}
	// A non-silent flow reads back as such (the column defaults to 0).
	if err := db.SaveOIDCFlowState(ctx, "plain", OIDCFlowState{Nonce: "n", Verifier: "v", ReturnTo: "/app/"}, now); err != nil {
		t.Fatal(err)
	}
	if fs, found, _ := db.TakeOIDCFlowState(ctx, "plain"); !found || fs.Silent {
		t.Fatalf("plain take = (%+v,%v), want found and not silent", fs, found)
	}
	// Expired (created 11m ago) → not found.
	if err := db.SaveOIDCFlowState(ctx, "old", OIDCFlowState{Nonce: "n", Verifier: "v", ReturnTo: "/admin"}, now.Add(-11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.TakeOIDCFlowState(ctx, "old"); found {
		t.Fatal("expired flow state should not be found")
	}
}

func TestOIDCFlowStateConcurrentTakeHasSingleWinner(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	if err := db.SaveOIDCFlowState(ctx, "concurrent", OIDCFlowState{Nonce: "nonce", Verifier: "verifier", ReturnTo: "/app/"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	type takeResult struct {
		fs    OIDCFlowState
		found bool
		err   error
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
			fs, found, err := db.TakeOIDCFlowState(ctx, "concurrent")
			results <- takeResult{fs: fs, found: found, err: err}
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
		if result.fs.Nonce != "nonce" || result.fs.Verifier != "verifier" || result.fs.ReturnTo != "/app/" {
			t.Fatalf("winner returned unexpected state: %+v", result)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent take winners = %d, want 1", winners)
	}
}
