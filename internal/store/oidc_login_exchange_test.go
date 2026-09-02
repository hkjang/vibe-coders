package store

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestOIDCLoginExchangeIsShortLivedAndSingleUse(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	exchange := OIDCLoginExchange{
		CodeHash: "hash-1", UserID: "user-1", TeamID: "team-1", KeycloakSID: "sid-1", CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveOIDCLoginExchange(ctx, exchange); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.TakeOIDCLoginExchange(ctx, exchange.CodeHash)
	if err != nil || !found || got.UserID != exchange.UserID || got.TeamID != exchange.TeamID || got.KeycloakSID != exchange.KeycloakSID {
		t.Fatalf("take = %+v found=%v err=%v", got, found, err)
	}
	if _, found, err := db.TakeOIDCLoginExchange(ctx, exchange.CodeHash); err != nil || found {
		t.Fatalf("second take: found=%v err=%v", found, err)
	}

	expired := exchange
	expired.CodeHash = "expired-hash"
	expired.CreatedAt = time.Now().Add(-3 * time.Minute)
	if err := db.SaveOIDCLoginExchange(ctx, expired); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.TakeOIDCLoginExchange(ctx, expired.CodeHash); err != nil || found {
		t.Fatalf("expired exchange: found=%v err=%v", found, err)
	}
}

func TestOIDCLoginExchangeConcurrentTakeHasOneWinner(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	if err := db.SaveOIDCLoginExchange(ctx, OIDCLoginExchange{CodeHash: "shared-hash", UserID: "user-1"}); err != nil {
		t.Fatal(err)
	}

	const consumers = 8
	start := make(chan struct{})
	results := make(chan bool, consumers)
	errs := make(chan error, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, found, err := db.TakeOIDCLoginExchange(ctx, "shared-hash")
			results <- found
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	winners := 0
	for found := range results {
		if found {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("winners = %d, want 1", winners)
	}
}
