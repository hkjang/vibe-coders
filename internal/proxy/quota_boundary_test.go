package proxy

import (
	"context"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// boundaryFixture is a gateway with one key and usage seeded directly, so a limit can be
// placed exactly on the usage rather than approached through pricing.
func boundaryFixture(t *testing.T, usedTokens int64, usedCostKRW float64) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	ctx := context.Background()
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "k1", Name: "k1", KeyHash: hashProxyKey("sk-b"), Owner: "u", UserID: "u",
		Role: "member", Status: "active", CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	// One request carrying exactly the usage the limit will be set against.
	now := time.Now().UTC()
	if err := db.InsertLogRecord(ctx, store.LogRecord{
		Request: store.RequestLog{ID: "seed", TraceID: "seed", APIKeyID: "k1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now},
		Usage: &store.TokenUsage{ID: "u-seed", RequestID: "seed",
			TotalTokens: int(usedTokens), EstimatedCost: usedCostKRW, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	upstream := httptest.NewServer(nil)
	t.Cleanup(upstream.Close)
	server, err := NewServer(testConfig(upstream.URL, "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

// A quota is a ceiling, so usage that has reached it is spent: the request at the limit is
// refused, and the one a hair below is not.
//
// The token side of this is covered end to end. The cost side was not, and cost is the
// limit operators actually set — a budget in won, not in tokens. Approaching it through
// real pricing cannot land exactly on the boundary, so the usage is seeded and the limit
// placed on it.
func TestQuotaBoundariesRefuseAtTheLimitAndNotBefore(t *testing.T) {
	cases := []struct {
		name       string
		usedTokens int64
		usedCost   float64
		quota      store.QuotaRecord
		wantAllow  bool
		wantReason string
	}{
		{"cost exactly at the limit is refused", 0, 100,
			store.QuotaRecord{KRWLimit: 100}, false, "krw_limit_exceeded"},
		{"cost a hair below the limit is allowed", 0, 99.99,
			store.QuotaRecord{KRWLimit: 100}, true, ""},
		{"cost past the limit is refused", 0, 100.01,
			store.QuotaRecord{KRWLimit: 100}, false, "krw_limit_exceeded"},
		{"tokens exactly at the limit are refused", 200, 0,
			store.QuotaRecord{TokenLimit: 200}, false, "token_limit_exceeded"},
		{"tokens one below the limit are allowed", 199, 0,
			store.QuotaRecord{TokenLimit: 200}, true, ""},
		// A limit of zero means unlimited, which is how an operator leaves one half of a
		// quota unset. Reading it as "nothing allowed" would refuse everything.
		{"a zero cost limit means unlimited", 0, 500,
			store.QuotaRecord{KRWLimit: 0, TokenLimit: 1000}, true, ""},
		{"a zero token limit means unlimited", 5000, 0,
			store.QuotaRecord{TokenLimit: 0, KRWLimit: 1000}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, db := boundaryFixture(t, tc.usedTokens, tc.usedCost)
			q := tc.quota
			q.ID, q.Scope, q.ScopeValue, q.Period, q.Enabled = "q1", "api_key", "k1", "daily", true
			q.CreatedAt = time.Now().UTC()
			if err := db.UpsertQuota(context.Background(), q); err != nil {
				t.Fatal(err)
			}

			decision, err := server.checkQuotas(context.Background(), "k1", "", nil)
			if err != nil {
				t.Fatal(err)
			}
			if decision.Allowed != tc.wantAllow {
				t.Fatalf("allowed=%v want %v (usage %d tokens / %v krw against %+v; reason %q)",
					decision.Allowed, tc.wantAllow, tc.usedTokens, tc.usedCost, tc.quota, decision.Reason)
			}
			if !tc.wantAllow && decision.Reason != tc.wantReason {
				t.Fatalf("refused with reason %q, want %q", decision.Reason, tc.wantReason)
			}
		})
	}
}

// Turning reservations off has to stop them being written, not just stop them being read.
// Rows for a switched-off feature accumulate in a table nothing prunes, and the switch
// looks like it works because the totals they would have contributed are ignored anyway.
func TestDisabledReservationsWriteNothing(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			db := openTestStore(t)
			defer db.Close()
			logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
			logger.Start()
			defer logger.Stop(context.Background())

			cfg := testConfig("http://example.invalid", "s")
			cfg.Quota.ReservationsEnabled = enabled
			server, err := NewServer(cfg, db, logger, nil)
			if err != nil {
				t.Fatal(err)
			}

			ctx := context.Background()
			server.reserveQuota(ctx, "req-1", "k1", "10.0.0.1", 100, 5)

			reserved, _, err := db.ReservedUsage(ctx, "api_key", "k1", time.Now().UTC())
			if err != nil {
				t.Fatal(err)
			}
			want := int64(0)
			if enabled {
				want = 100
			}
			if reserved != want {
				t.Fatalf("reservations enabled=%v left %d reserved tokens, want %d", enabled, reserved, want)
			}
		})
	}
}
