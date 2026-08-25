package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Quota enforcement, end to end.
//
// Two things have to hold and neither is visible from reading the code. Usage has to stop
// at the limit — not before it, which refuses people who have quota left, and not well
// past it, which is what a quota exists to prevent. And every reservation has to be
// released, on the failure path as much as the happy one: a reservation that is not
// returned keeps counting against the key until it expires, so the next caller is refused
// for spend that never happened.
//
// The reservation lifecycle is the fragile half. It hangs on a deferred release, and a
// new early return added above it would leak silently — the request still works, the
// quota just drifts.

type quotaFixture struct {
	proxy *httptest.Server
	db    *store.SQLStore
	body  []byte
}

func newQuotaFixture(t *testing.T, upstreamURL, keyID, secret string, tokenLimit int64) *quotaFixture {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	ctx := context.Background()
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: keyID, Name: keyID, KeyHash: hashProxyKey(secret),
		Owner: "u", UserID: "u", Role: "member", Status: "active", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q-" + keyID, Scope: "api_key", ScopeValue: keyID, Period: "daily",
		TokenLimit: tokenLimit, Enabled: true, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig(upstreamURL, "s")
	cfg.Auth.AdminToken = "rw"
	cfg.Quota.ReservationsEnabled = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)

	body, _ := json.Marshal(map[string]any{"model": "test-model",
		"messages": []map[string]string{{"role": "user", "content": "hi"}}})
	return &quotaFixture{proxy: proxy, db: db, body: body}
}

func (f *quotaFixture) call(t *testing.T, secret string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.proxy.URL+"/v1/chat/completions", bytes.NewReader(f.body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func TestQuotaStopsExactlyAtTheLimitAndReleasesReservations(t *testing.T) {
	// 20 tokens per response, 200-token daily limit: ten requests fit, the eleventh
	// must not.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}`))
	}))
	defer upstream.Close()

	f := newQuotaFixture(t, upstream.URL, "key-q", "sk-q", 200)

	admitted, firstRefusalAt := 0, 0
	for i := 1; i <= 20; i++ {
		if f.call(t, "sk-q") == http.StatusOK {
			admitted++
		} else if firstRefusalAt == 0 {
			firstRefusalAt = i
		}
		time.Sleep(30 * time.Millisecond) // the usage is committed by the async logger
	}
	if admitted != 10 {
		t.Errorf("a 200-token quota admitted %d requests of 20 tokens each, want 10", admitted)
	}
	if firstRefusalAt != 11 {
		t.Errorf("the first refusal was request %d, want 11 — refusing earlier turns away "+
			"a caller who still has quota, refusing later spends past the limit", firstRefusalAt)
	}

	ctx := context.Background()
	time.Sleep(400 * time.Millisecond)
	_, _, tokens, err := f.db.UsageSince(ctx, store.UsageFilter{
		Scope: "api_key", ScopeValue: "key-q", Since: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 200 {
		t.Errorf("committed usage is %d tokens against a 200 limit; enforcement and accounting disagree", tokens)
	}
	reserved, _, err := f.db.ReservedUsage(ctx, "api_key", "key-q", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reserved != 0 {
		t.Errorf("%d reserved tokens are still outstanding after every request finished; "+
			"they keep counting against this key until they expire", reserved)
	}
}

// The failure path matters more than the happy one here: it is the one with an extra
// early return, and a reservation stranded by a failed request refuses the next caller
// for spend that never happened.
func TestFailedRequestsDoNotStrandQuotaReservations(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"upstream is unwell"}`))
	}))
	defer dead.Close()

	f := newQuotaFixture(t, dead.URL, "key-f", "sk-f", 10000)

	for i := 0; i < 8; i++ {
		if code := f.call(t, "sk-f"); code == http.StatusOK {
			t.Fatalf("request %d succeeded against an upstream that always fails", i)
		}
	}
	time.Sleep(500 * time.Millisecond)

	reserved, cost, err := f.db.ReservedUsage(context.Background(), "api_key", "key-f", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if reserved != 0 || cost != 0 {
		t.Errorf("eight failed requests left %d tokens and %v KRW reserved; a request that "+
			"never reached the model is still counting against the caller's quota", reserved, cost)
	}
}
