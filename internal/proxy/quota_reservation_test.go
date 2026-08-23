package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// The defect this closes: quotas are checked against committed usage, which is only
// written once a request finishes. The blind window is therefore the whole duration of
// every in-flight request — seconds to minutes for an LLM call — so a burst of
// concurrent requests each measure themselves against a total that excludes all the
// others and can collectively sail past the limit.
func TestQuotaCountsInFlightRequests(t *testing.T) {
	// Hold every upstream call open until the test releases it. That open window is
	// exactly the period committed usage cannot see.
	release := make(chan struct{})
	var inFlight atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inFlight.Add(1)
		// Bounded so a regression fails as an assertion rather than hanging: if the
		// followers are wrongly admitted they would otherwise block here forever, since
		// nothing closes the channel until they have all returned.
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":100,"total_tokens":200}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Quota.ReservationsEnabled = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	ctx := context.Background()
	// A limit of one token means: the first request is admitted against an empty ledger,
	// and every later one must see that first request's reservation and be refused. With
	// only committed usage this limit would never bite, because nothing has completed.
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q1", Scope: "global", ScopeValue: "*", Period: "daily",
		TokenLimit: 1, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	send := func() int {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
		defer resp.Body.Close()
		return resp.StatusCode
	}

	// Start one request and wait until it is genuinely in flight, so the followers are
	// guaranteed to check after its reservation exists. Firing everything at once would
	// leave the outcome to scheduling.
	firstDone := make(chan int, 1)
	go func() { firstDone <- send() }()

	deadline := time.Now().Add(5 * time.Second)
	for inFlight.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if inFlight.Load() == 0 {
		t.Fatal("the first request never reached the upstream")
	}

	// The reservation must be visible to anyone checking the quota right now — this is
	// the property the whole change exists for.
	reserved, _, err := db.ReservedUsage(ctx, "global", "*", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reserved <= 0 {
		t.Fatal("an in-flight request reserved nothing; concurrent requests cannot see it")
	}
	// And committed usage must still be empty, proving the reservation is the only thing
	// making the request visible.
	if _, _, committed, uerr := db.UsageSince(ctx, store.UsageFilter{Scope: "global", ScopeValue: "*", Since: time.Now().Add(-time.Hour)}); uerr != nil {
		t.Fatal(uerr)
	} else if committed != 0 {
		t.Fatalf("committed usage is %d while the request is still running", committed)
	}

	const followers = 4
	codes := make([]int, followers)
	var wg sync.WaitGroup
	for i := 0; i < followers; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); codes[i] = send() }(i)
	}
	wg.Wait()

	blocked := 0
	for _, c := range codes {
		if c == http.StatusTooManyRequests {
			blocked++
		}
	}
	if blocked != followers {
		t.Fatalf("followers=%v, blocked %d of %d — requests started during an in-flight "+
			"request are not counting it", codes, blocked, followers)
	}

	close(release)
	if code := <-firstDone; code != http.StatusOK {
		t.Fatalf("the first request should have been admitted, got %d", code)
	}
	t.Logf("1 admitted against an empty ledger, %d refused while it was still running", blocked)

	// Once everything has finished, nothing may remain reserved.
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		tokens, _, rerr := db.ReservedUsage(ctx, "global", "*", time.Now())
		if rerr == nil && tokens == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("reservations outlived their requests")
}

// Reservations are per request and must be released on every exit path, including the
// ones that never reach an upstream.
func TestQuotaReservationReleasedOnBlockedRequest(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unreachable.invalid", "secret")
	cfg.Quota.ReservationsEnabled = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// The upstream is unreachable, so this request fails after reserving.
	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	resp.Body.Close()

	tokens, cost, err := db.ReservedUsage(context.Background(), "global", "*", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 0 || cost != 0 {
		t.Fatalf("a failed request left its reservation behind: tokens=%d cost=%v", tokens, cost)
	}
}

func TestReservedUsageScopingAndExpiry(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "key-a", Name: "a", KeyHash: "ha", Team: "platform", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}

	live := store.QuotaReservation{
		RequestID: "r1", APIKeyID: "key-a", ClientIP: "10.0.0.1",
		Tokens: 100, CostKRW: 5, ExpiresAt: now.Add(time.Hour),
	}
	expired := store.QuotaReservation{
		RequestID: "r2", APIKeyID: "key-a", ClientIP: "10.0.0.1",
		Tokens: 999, CostKRW: 999, ExpiresAt: now.Add(-time.Minute),
	}
	other := store.QuotaReservation{
		RequestID: "r3", APIKeyID: "key-b", ClientIP: "10.0.0.2",
		Tokens: 7, CostKRW: 1, ExpiresAt: now.Add(time.Hour),
	}
	for _, r := range []store.QuotaReservation{live, expired, other} {
		if err := db.ReserveQuota(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	check := func(scope, value string, wantTokens int64) {
		t.Helper()
		tokens, _, err := db.ReservedUsage(ctx, scope, value, now)
		if err != nil {
			t.Fatal(err)
		}
		if tokens != wantTokens {
			t.Fatalf("%s=%s reserved %d tokens, want %d", scope, value, tokens, wantTokens)
		}
	}
	// An expired row must never be counted, however long the sweeper has been asleep.
	check("api_key", "key-a", 100)
	check("ip", "10.0.0.1", 100)
	check("team", "platform", 100)
	check("api_key", "key-b", 7)
	check("global", "*", 107)
	// A key with no team falls into "unassigned", matching committed-usage semantics.
	check("team", "unassigned", 7)

	// Releasing is idempotent and only affects the named request.
	if err := db.ReleaseQuota(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if err := db.ReleaseQuota(ctx, "r1"); err != nil {
		t.Fatalf("releasing twice should be harmless: %v", err)
	}
	check("global", "*", 7)

	// The sweeper removes expired rows that reads were already ignoring.
	removed, err := db.SweepExpiredQuotaReservations(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("sweep removed %d rows, want 1 (only the expired one)", removed)
	}
	check("global", "*", 7)
}

// Turning the mechanism off must leave the previous behaviour untouched.
func TestQuotaReservationsCanBeDisabled(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unreachable.invalid", "secret")
	cfg.Quota.ReservationsEnabled = false
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if server.quotaReservationsEnabled() {
		t.Fatal("reservations reported as enabled when configured off")
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	resp.Body.Close()

	tokens, _, err := db.ReservedUsage(context.Background(), "global", "*", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 0 {
		t.Fatalf("a reservation was written with the feature disabled: %d tokens", tokens)
	}
}

// A 429 whose numbers cannot be reconciled with the operator's own dashboard is a
// support ticket. The refusal has to carry the limit it hit and how much of the total
// came from work still running, and /admin/quotas has to report the same total that
// enforcement compared.
func TestQuotaRefusalAndAdminViewExplainReservations(t *testing.T) {
	release := make(chan struct{})
	var inFlight atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inFlight.Add(1)
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Quota.ReservationsEnabled = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	ctx := context.Background()
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q1", Scope: "global", ScopeValue: "*", Period: "daily",
		TokenLimit: 1, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	go func() {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
		resp.Body.Close()
	}()
	deadline := time.Now().Add(5 * time.Second)
	for inFlight.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if inFlight.Load() == 0 {
		t.Fatal("the first request never reached the upstream")
	}

	// The refusal must be self-explanatory.
	refused := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	defer refused.Body.Close()
	if refused.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 while a request holds the quota, got %d", refused.StatusCode)
	}
	if got := refused.Header.Get("X-Quota-Token-Limit"); got != "1" {
		t.Fatalf("X-Quota-Token-Limit=%q — without the limit the reported totals mean nothing", got)
	}
	reserved := refused.Header.Get("X-Quota-Reserved-Tokens")
	if reserved == "" || reserved == "0" {
		t.Fatalf("X-Quota-Reserved-Tokens=%q — the caller cannot tell the refusal came from in-flight work", reserved)
	}

	// The admin view must report the same total, not just what has completed.
	adminResp, err := http.Get(proxy.URL + "/admin/quotas")
	if err != nil {
		t.Fatal(err)
	}
	defer adminResp.Body.Close()
	var out struct {
		Usage []struct {
			Tokens          int64   `json:"tokens"`
			ReservedTokens  int64   `json:"reserved_tokens"`
			ReservedCostKRW float64 `json:"reserved_cost_krw"`
			TokenRemain     float64 `json:"token_remain_ratio"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(adminResp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Usage) != 1 {
		t.Fatalf("expected one quota in the admin view, got %d", len(out.Usage))
	}
	u := out.Usage[0]
	if u.Tokens != 0 {
		t.Fatalf("committed usage is %d while the only request is still running", u.Tokens)
	}
	if u.ReservedTokens <= 0 {
		t.Fatal("the admin view reports no in-flight usage, so a full quota would look empty")
	}
	if u.TokenRemain != 0 {
		t.Fatalf("token_remain_ratio=%v — the quota is exhausted by in-flight work and must not read as having room", u.TokenRemain)
	}

	close(release)
}

// Embeddings consume quota and a batch job issues them by the thousand concurrently,
// which is exactly the shape that overshoots a limit. They must reserve while in flight
// like chat does, and must not be over-reserved for a completion they never produce.
func TestEmbeddingsReserveQuotaWhileInFlight(t *testing.T) {
	release := make(chan struct{})
	var inFlight atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inFlight.Add(1)
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]}],"model":"test-model","usage":{"prompt_tokens":8,"total_tokens":8}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Quota.ReservationsEnabled = true
	cfg.Cache.EmbeddingEnabled = false // a cache hit would never reach the upstream
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	ctx := context.Background()
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q1", Scope: "global", ScopeValue: "*", Period: "daily",
		TokenLimit: 1, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	body := map[string]any{"model": "test-model", "input": "embed this sentence"}
	go func() {
		resp := postJSON(t, proxy.URL+"/v1/embeddings", "", body)
		resp.Body.Close()
	}()
	deadline := time.Now().Add(5 * time.Second)
	for inFlight.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if inFlight.Load() == 0 {
		t.Fatal("the embedding request never reached the upstream")
	}

	reserved, _, err := db.ReservedUsage(ctx, "global", "*", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reserved <= 0 {
		t.Fatal("an in-flight embedding reserved nothing; a concurrent batch cannot see itself")
	}
	// An embedding produces no completion. Reserving a predicted output would inflate
	// every call by the default completion estimate and start refusing valid traffic.
	if reserved >= int64(defaultExpectedOutputTokens) {
		t.Fatalf("reserved %d tokens for an embedding — a completion estimate is being "+
			"counted for a request that produces none", reserved)
	}

	// A second request must see the first one's reservation.
	second := postJSON(t, proxy.URL+"/v1/embeddings", "", body)
	defer second.Body.Close()
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("a concurrent embedding was admitted past a full quota: %d", second.StatusCode)
	}

	close(release)
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if tokens, _, rerr := db.ReservedUsage(ctx, "global", "*", time.Now()); rerr == nil && tokens == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the embedding reservation outlived its request")
}
