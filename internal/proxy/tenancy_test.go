package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Tenancy.
//
// Refusing anonymous callers is one property; showing an authenticated caller only their
// own rows is a different one, and it is the one that fails quietly. Every /me handler
// resolves the caller and then filters by that identity in its own query — a filter
// dropped in a refactor produces no error, no log line, and a response that looks
// entirely normal until someone notices another user's model names in it.
//
// So this asks the question the way an attacker would: put two users' data in one store,
// authenticate as one, and look for the other's fingerprints in every response.

type tenant struct {
	userID, team, marker, key string
}

var tenants = []tenant{
	{userID: "user-alice", team: "team-alpha", marker: "alice", key: "sk-alice"},
	{userID: "user-mallory", team: "team-beta", marker: "mallory", key: "sk-mallory"},
}

// seedTenants gives each tenant an API key and three requests whose model and prompt
// names carry their marker, so any row that escapes its owner is recognisable in a
// response body regardless of which field it surfaces in.
func seedTenants(t *testing.T, db *store.SQLStore, now time.Time) {
	t.Helper()
	ctx := context.Background()
	for _, u := range tenants {
		if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
			ID: "key-" + u.marker, Name: "key-" + u.marker, KeyHash: hashProxyKey(u.key),
			Owner: u.userID, Team: u.team, UserID: u.userID, Role: "member", Status: "active",
			Scopes: []string{"team:read"}, CreatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
				ID:         u.marker + "-r" + string(rune('a'+i)),
				TraceID:    u.marker + "-t" + string(rune('a'+i)),
				Endpoint:   "/v1/chat/completions",
				Model:      "model-" + u.marker,
				Provider:   "up",
				StatusCode: 200,
				LatencyMS:  100,
				APIKeyID:   "key-" + u.marker,
				PromptName: "prompt-" + u.marker,
				CreatedAt:  now.Add(-time.Duration(i) * time.Minute),
			}}); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestMeRoutesNeverReturnAnotherUsersData(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	now := time.Now().UTC()
	seedTenants(t, db, now)

	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AdminToken = "rw-secret"
	cfg.Auth.SelfServiceKeys = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()

	var routes []string
	seen := map[string]bool{}
	for _, m := range regexp.MustCompile(`mux\.HandleFunc\("(/me[^"]*)"`).
		FindAllStringSubmatch(readProxyFile(t, "server.go"), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			routes = append(routes, m[1])
		}
	}
	sort.Strings(routes)

	// Counting the routes that answered with the caller's own data is not decoration.
	// Every handler here refuses a caller it cannot identify, so a fixture that fails to
	// authenticate turns the whole test into 401s — which contain no other user's data
	// either, and would pass. The test would then prove nothing while looking green.
	servedOwnData := 0
	for _, route := range routes {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+route, nil)
		req.Header.Set("Authorization", "Bearer "+tenants[0].key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Errorf("GET %s: %v", route, err)
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64000))
		resp.Body.Close()
		body := string(raw)

		if strings.Contains(body, tenants[0].marker) {
			servedOwnData++
		}
		if idx := strings.Index(body, tenants[1].marker); idx >= 0 {
			lo := idx - 120
			if lo < 0 {
				lo = 0
			}
			t.Errorf("GET %s, authenticated as %s, returned %s's data (%d):\n  …%s…",
				route, tenants[0].userID, tenants[1].userID, resp.StatusCode, body[lo:])
		}
	}
	if servedOwnData < 5 {
		t.Fatalf("only %d of %d /me routes returned the caller's own data — the fixture is not "+
			"authenticating, so this test is not exercising the filters it claims to check",
			servedOwnData, len(routes))
	}
}

// The /team surface takes a ?team= parameter, which is the shape of query-parameter
// privilege escalation: read another team by naming it. It is allowed on purpose, but
// only for a caller holding admin:read, and both halves of that are worth pinning — the
// refusal, so the check cannot be dropped, and the permission, so it cannot be tightened
// into uselessness without someone noticing.
func TestTeamScopeOverrideRequiresAdminRead(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	now := time.Now().UTC()
	seedTenants(t, db, now)
	ctx := context.Background()
	if err := db.InsertAuthSession(ctx, "sess-alice", "user-alice", "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AdminToken = "rw-secret"
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "jwt-test-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()

	token := func(scopes ...string) string {
		tok, err := server.signAccessToken(accessClaims{
			Subject: "user-alice", Role: "member", TeamID: "team-alpha", Scopes: scopes,
			SessionID: "sess-alice", Type: "access",
			IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	member := token("team:read")
	elevated := token("team:read", "admin:read")

	get := func(url, tok string) (int, string) {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64000))
		resp.Body.Close()
		return resp.StatusCode, string(raw)
	}

	for _, route := range []string{"/team/dashboard", "/team/portal", "/team/reports", "/team/risk", "/team/skills/popular"} {
		// Baseline: the caller can read their own team. Without this the two checks
		// below would pass on any response that simply failed.
		if code, body := get(ts.URL+route, member); code != http.StatusOK || !strings.Contains(body, "team-alpha") {
			t.Fatalf("GET %s as a team-alpha member: got %d, own team present=%v — the fixture is broken",
				route, code, strings.Contains(body, "team-alpha"))
		}
		// A member naming another team is pinned back to their own, not refused: the
		// parameter is ignored rather than honoured.
		code, body := get(ts.URL+route+"?team=team-beta", member)
		if strings.Contains(body, "team-beta") {
			t.Errorf("GET %s?team=team-beta as a member without admin:read returned team-beta data (%d) — "+
				"any authenticated user could read any team by naming it", route, code)
		}
		if code == http.StatusOK && !strings.Contains(body, "team-alpha") {
			t.Errorf("GET %s?team=team-beta as a member returned 200 but not the caller's own team; "+
				"the override should fall back to the caller's team", route)
		}
		// With admin:read it is meant to work.
		if code, body := get(ts.URL+route+"?team=team-beta", elevated); code != http.StatusOK || !strings.Contains(body, "team-beta") {
			t.Errorf("GET %s?team=team-beta with admin:read: got %d, team-beta present=%v — "+
				"the documented admin override has stopped working", route, code, strings.Contains(body, "team-beta"))
		}
	}
}
