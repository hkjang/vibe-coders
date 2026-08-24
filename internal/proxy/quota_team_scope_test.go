package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// A team-scoped quota has to be enforced against the value api_keys.team holds, which is
// what quota rows are scoped by — not the canonical team id authentication resolves for
// display.
//
// The two differ whenever a key's team column holds a name: enrichAuthContextTeam replaces
// AuthContext.TeamID with the team's id, so a request path that reused that field would
// charge the request to a scope value no quota was written against, and every team limit
// would silently stop applying.
func TestTeamQuotaUsesTheKeysOwnTeamValue(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":100,"total_tokens":200}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	ctx := context.Background()
	now := time.Now().UTC()

	// The key's team column holds the team's *name*; the team's id is something else.
	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: "t_canonical_id", Name: "alpha", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	secret := "sk-team"
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "k-team", Name: "team key", KeyHash: hashProxyKey(secret), Owner: "o", UserID: "u",
		Team: "alpha", Role: "member", Status: "active", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}

	send := func() int {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", secret, chatBody("test-model", false))
		defer resp.Body.Close()
		return resp.StatusCode
	}

	// A quota written against the canonical team id must not apply: no request is scoped
	// to it. If this refuses, the request is being charged to the wrong scope value.
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q-by-id", Scope: "team", ScopeValue: "t_canonical_id", Period: "daily",
		TokenLimit: 1, Enabled: true, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if got := send(); got != http.StatusOK {
		t.Fatalf("a quota written against the canonical team id refused the request (%d); "+
			"quota rows are scoped by api_keys.team, not by the resolved id", got)
	}
	if err := db.DeleteQuota(ctx, "q-by-id"); err != nil {
		t.Fatal(err)
	}

	// A quota written against the key's own team value must apply.
	if err := db.UpsertQuota(ctx, store.QuotaRecord{
		ID: "q-by-team", Scope: "team", ScopeValue: "alpha", Period: "daily",
		TokenLimit: 1, Enabled: true, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, func() bool {
		requests, _, _, err := db.UsageForPeriod(ctx, store.UsageFilter{
			Scope: "team", ScopeValue: "alpha", Since: time.Now().Add(-24 * time.Hour)})
		return err == nil && requests > 0
	})
	if got := send(); got != http.StatusTooManyRequests {
		t.Fatalf("a team quota on the key's own team value got %d, want %d — it is not being enforced",
			got, http.StatusTooManyRequests)
	}
}
