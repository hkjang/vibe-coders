package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// Authorization coverage.
//
// There is no middleware in front of any of this: each of the 390-plus handlers checks
// the caller itself as its first statement — s.authorizeAdmin for /admin, s.meUserID or
// s.resolveTeamScope or s.authorizeScope for the user-facing routes. That works right up until one
// handler doesn't — and one didn't. /admin/llm/prompts/compare answered unauthenticated
// callers with 200 and real data (prompt names and versions, call volumes, cost, latency,
// error and eval-failure rates) while its ten siblings under /admin/llm all returned 401.
//
// Nothing failed when that check was omitted, because nothing was checking. This test is
// that check: it drives a real unauthenticated request at every route the server
// registers and requires the server to refuse. It reads the route list out of the
// registration source, so a route added tomorrow is covered without anyone remembering
// to add it here.
//
// It runs with AUTH_ENABLED on. Several /me and /team handlers deliberately serve
// everyone when authentication is switched off (single-user mode); probing with it off
// would measure that mode instead of the one this is about.
//
// The assertion is deliberately "not 2xx" rather than "401". A handler that rejects the
// method first (405), or the path (404 from a prefix router), has also disclosed nothing,
// and pinning the exact code here would make the test fail on harmless refactors instead
// of on the thing that matters.
//
// Each route is tried twice: bare, and again carrying the query parameters below. The
// first version of this test only sent the bare request, and it passed against the very
// bug it was written for — /admin/llm/prompts/compare answers a parameterless GET with
// "prompt_name is required" (400), which is not 2xx, so the leak sat one required
// parameter out of reach. A test that cannot fail on its founding defect is not evidence
// of anything.

// Routes that are meant to answer an unauthenticated caller, with the reason each one
// is safe to serve. Everything else the server registers must refuse.
//
// The list is short on purpose: adding to it is how a route stops being checked, so each
// entry has to say why the response carries nothing worth protecting.
var publicRoutes = map[string]string{
	"/admin":              "the console shell itself — it has to load before anyone can log in, and it carries no data; every panel in it fetches from the guarded APIs",
	"/admin/":             "same shell, trailing-slash form",
	"/admin/ui-bootstrap": "public login/bootstrap metadata only; authenticated identity and permissions are included only after a valid credential",

	"/":             "landing page, static HTML",
	"/favicon.ico":  "static icon",
	"/health":       "liveness probe — a fixed {\"status\":\"ok\"}, and it has to answer before anything is configured",
	"/ready":        "readiness probe, same reasoning",
	"/metrics":      "Prometheus scrape endpoint; exposed by convention and expected to be restricted at the network layer rather than by a token",
	"/openapi.json": "the published API description — it documents the endpoints, it does not read from them",
	"/swagger":      "the viewer for the spec above",

	"/auth/login":                        "issues credentials; it cannot require them",
	"/auth/refresh":                      "exchanges a refresh token, which is itself the credential",
	"/auth/logout":                       "idempotent, returns only {\"status\":\"logged_out\"}",
	"/auth/me":                           "reports who the caller is; with no token it answers accordingly",
	"/auth/sso/status":                   "public login configuration — which provider to use and whether local login is allowed; the browser needs it to render the login screen",
	"/auth/keycloak/login":               "starts the OIDC redirect",
	"/auth/keycloak/callback":            "receives the OIDC redirect; the authorization code is the credential",
	"/auth/keycloak/logout":              "idempotent logout",
	"/auth/keycloak/frontchannel-logout": "OIDC front-channel logout, called by the identity provider",
	"/auth/keycloak/backchannel-logout":  "OIDC back-channel logout, authenticated by the logout token in the body",

	"/vcs/events":   "webhook receiver, authenticated by the sender's signature rather than a gateway token",
	"/vcs/webhook/": "same receiver, path-prefixed form",

	"/me/access-denied":     "a telemetry sink for the client's own denied-request notice; it stores nothing and answers {\"status\":\"ignored\"}",
	"/me/connection-doctor": "diagnoses why a caller's credentials are not working, so requiring working credentials would defeat it; it reports the gateway's own base URL and the outcome of its checks, nothing about other users",
}

var routeRe = regexp.MustCompile(`mux\.HandleFunc\("([^"]+)"`)

// Query strings tried against every route, one parameter at a time.
//
// One at a time, not combined, and that is the whole lesson of this test. Handlers read
// two kinds of parameter: identifiers that name a subject, and filters that narrow the
// result — and admin filters compose, so any extra parameter can exclude the seeded row
// and turn a leak into an honest-looking 404.
//
// The first two attempts at this test both passed against the very bug it exists for.
// A bare GET on /admin/llm/prompts/compare stops at "prompt_name is required" (400), so
// the leak sat one parameter out of reach; adding a bundle of parameters put it back out
// of reach from the other side, because session_id= in the same bundle filtered the row
// away before the response was built. Sent alone, prompt_name= reaches it and the
// endpoint answers 200 with data. A test that cannot fail on its founding defect is not
// evidence of anything, so each probe is kept to a single parameter.
var adminProbeQueries = []string{
	"",
	"?prompt_name=checkout-agent",
	"?name=checkout-agent",
	"?key=cache.embedding_ttl",
	"?id=auth-cov-1",
	"?request_id=auth-cov-1",
	"?trace_id=auth-cov-1",
	"?session_id=auth-cov-1",
	"?provider=up",
	"?model=m",
	"?endpoint=/v1/chat/completions",
	"?days=1",
	"?limit=1",
	"?q=a",
}

func TestEveryRouteRefusesUnauthenticatedRequests(t *testing.T) {
	raw := readProxyFile(t, "server.go")
	seen := map[string]bool{}
	var routes []string
	for _, m := range routeRe.FindAllStringSubmatch(raw, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			routes = append(routes, m[1])
		}
	}
	sort.Strings(routes)
	if len(routes) < 380 {
		t.Fatalf("only %d routes were extracted from server.go; the extractor has stopped matching", len(routes))
	}

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AdminToken = "rw-secret"
	// Auth on, because that is the posture this test is about. Several /me and /team
	// handlers deliberately open up when AUTH_ENABLED is false (single-user mode), and
	// probing with it off would measure that mode rather than the deployed one.
	cfg.Auth.Enabled = true
	cfg.Auth.SelfServiceKeys = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()

	// One row so a leaking read has something to leak: an endpoint that answers 200 with
	// an empty result set looks the same as one that refused, and would hide the bug.
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{Request: store.RequestLog{
		ID: "auth-cov-1", TraceID: "auth-cov-1", Endpoint: "/v1/chat/completions",
		Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 100,
		PromptName: "checkout-agent", PromptVersion: "v2",
	}}); err != nil {
		t.Fatal(err)
	}

	client := &http.Client{}
	for _, route := range routes {
		if _, ok := publicRoutes[route]; ok {
			continue
		}
		for _, probe := range adminProbeQueries {
			url := ts.URL + route + probe
			probeUnauthenticated(t, client, http.MethodGet, url, ts.URL, "")
			for _, payload := range adminProbeBodies {
				probeUnauthenticated(t, client, http.MethodPost, url, ts.URL, payload)
			}
		}
	}
}

// Bodies tried on POST. An empty object gets a handler as far as its own body
// validation and no further — which is not far enough: /admin/settings/rollback answers
// {} with "key is required" (400), so removing its authorization check would go
// unnoticed. The second body carries the field names admin handlers actually read, so a
// write that lost its guard is reached rather than turned away at the door.
var adminProbeBodies = []string{
	`{}`,
	`{"key":"cache.embedding_ttl","value":"1m","reason":"auth coverage probe","name":"auth-cov",` +
		`"id":"auth-cov-1","provider":"up","model":"m","enabled":false,"disabled":false}`,
}

// probeUnauthenticated issues one credential-less request and fails if the server
// answers with success. POSTs are sent as well as GETs: an unguarded read discloses,
// but an unguarded write also changes things, and mux routes both to the same handler.
func probeUnauthenticated(t *testing.T, client *http.Client, method, url, base, payloadBody string) {
	t.Helper()
	var body io.Reader
	if method == http.MethodPost {
		body = strings.NewReader(payloadBody)
	}
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Errorf("%s %s: request failed: %v", method, url, err)
		return
	}
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
	resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		t.Errorf("%s %s with no credentials returned %d — this endpoint is reachable by anyone who can reach the gateway.\n"+
			"Add the authorizeAdmin check, or record it in publicRoutes with the reason it is public.\nbody: %s",
			method, strings.TrimPrefix(url, base), resp.StatusCode, strings.TrimSpace(string(payload)))
	}
}

// The exemption list is the one place a route can be declared public, so it must not
// name routes that no longer exist — a stale entry silently exempts nothing today and
// could match a future route with the same path tomorrow.
func TestPublicRouteExemptionsAreAllRegistered(t *testing.T) {
	raw := readProxyFile(t, "server.go")
	registered := map[string]bool{}
	for _, m := range routeRe.FindAllStringSubmatch(raw, -1) {
		registered[m[1]] = true
	}
	for route, why := range publicRoutes {
		if !registered[route] {
			t.Errorf("publicRoutes exempts %q (%s) but no such route is registered", route, why)
		}
	}
}

// The second half of the same invariant, checked in the source rather than over HTTP.
//
// The live probe above proves what an unauthenticated caller actually gets, which is the
// strongest evidence available — but only where the response is observably different.
// Some handlers refuse for their own reasons before they would have disclosed anything:
// /admin/settings/rollback answers a well-formed request with 404 when the key has no
// history, so removing its authorization check changes no status code the probe can see.
// The endpoint is still unguarded, and the next request with real history behind it would
// roll back a setting for anyone who asked.
//
// So this test asks the flat question instead: does every handler bound to an /admin
// route contain an authorization call? It follows one level of delegation, because two
// handlers are one-line wrappers around a shared implementation that holds the check.
//
// Scoped to /admin deliberately. Those handlers share one guard, authorizeAdmin, which
// makes the source question answerable; the user-facing routes reach for whichever of
// half a dozen helpers fits, and a name-matching test over those would report absences
// that are not real. Those routes all return data on a GET, so the live probe above
// already fails on them when a guard goes missing — verified by removing one.
func TestEveryAdminHandlerCallsAuthorize(t *testing.T) {
	bodies := serverHandlerBodies(t)
	routes := map[string]string{} // handler name -> first route that binds it
	for _, m := range regexp.MustCompile(`mux\.HandleFunc\("(/admin[^"]*)",\s*s\.(\w+)\)`).
		FindAllStringSubmatch(readProxyFile(t, "server.go"), -1) {
		if _, ok := publicRoutes[m[1]]; ok {
			continue
		}
		if _, seen := routes[m[2]]; !seen {
			routes[m[2]] = m[1]
		}
	}
	if len(routes) < 250 {
		t.Fatalf("only %d admin handlers were extracted; the extractor has stopped matching", len(routes))
	}

	authorizes := regexp.MustCompile(`authorizeAdmin|authorizeScope`)
	callee := regexp.MustCompile(`s\.(handle\w+)\(w, r`)
	guarded := func(name string) bool {
		body, ok := bodies[name]
		if !ok {
			return false
		}
		if authorizes.MatchString(body) {
			return true
		}
		for _, c := range callee.FindAllStringSubmatch(body, -1) {
			if c[1] != name && authorizes.MatchString(bodies[c[1]]) {
				return true
			}
		}
		return false
	}

	var unguarded []string
	for name, route := range routes {
		if !guarded(name) {
			unguarded = append(unguarded, name+" ("+route+")")
		}
	}
	sort.Strings(unguarded)
	if len(unguarded) > 0 {
		t.Errorf("%d admin handler(s) never call authorizeAdmin/authorizeScope:\n  %s\n"+
			"Add the check, or record the route in publicRoutes with the reason it is public.",
			len(unguarded), strings.Join(unguarded, "\n  "))
	}
}

// serverHandlerBodies maps every http.HandlerFunc method on *Server to its source text.
func serverHandlerBodies(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	// Trailing parameters are allowed: the two settings connection-test routes are thin
	// wrappers over handleSettingsTestText2SQLDB(w, r, dbKind), and the guard lives there.
	sig := regexp.MustCompile(`(?m)^func \(s \*Server\) (\w+)\(w http\.ResponseWriter, r \*http\.Request[^)]*\) \{`)
	out := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		src := string(raw)
		locs := sig.FindAllStringSubmatchIndex(src, -1)
		for i, loc := range locs {
			end := len(src)
			if i+1 < len(locs) {
				end = locs[i+1][0]
			}
			out[src[loc[2]:loc[3]]] = src[loc[0]:end]
		}
	}
	return out
}
