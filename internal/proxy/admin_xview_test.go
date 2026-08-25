package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func xviewTestServer(t *testing.T) (*store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "xview.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	return db, srv
}

func seedXViewReq(t *testing.T, db *store.SQLStore, id, model, provider string, status int, failover bool, latency, tokens int64, cost float64, when time.Time) {
	seedXViewReqForKey(t, db, id, "k", model, provider, status, failover, latency, tokens, cost, when)
}

func seedXViewReqForKey(t *testing.T, db *store.SQLStore, id, apiKeyID, model, provider string, status int, failover bool, latency, tokens int64, cost float64, when time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, Endpoint: "/v1/chat/completions",
			Model: model, Provider: provider, StatusCode: status, Failover: failover,
			LatencyMS: latency, FirstChunkMS: latency / 2, CreatedAt: when,
		},
		Usage: &store.TokenUsage{
			ID: id + "_u", RequestID: id, TotalTokens: int(tokens),
			EstimatedCost: cost, Currency: "KRW", CreatedAt: when,
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestXViewTeamAdminCannotSeeOtherTeamPointsOrCursor(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	for _, team := range []store.AuthTeam{
		{ID: "team-alpha-id", Name: "team-alpha-name"},
		{ID: "team-beta-id", Name: "team-beta-name"},
	} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []store.APIKeyRecord{
		// API keys may persist a team display name while the access token carries its
		// canonical id. XView must match both forms without crossing the team boundary.
		{ID: "xv-key-alpha", Name: "alpha", KeyHash: "xv-hash-alpha", Team: "team-alpha-name", Status: "active"},
		{ID: "xv-key-beta", Name: "beta", KeyHash: "xv-hash-beta", Team: "team-beta-name", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	seedXViewReqForKey(t, db, "alpha-snapshot", "xv-key-alpha", "alpha-model", "openai", 200, false, 100, 10, 1, now)
	// Insert beta last so an unscoped high-water cursor would leak this request id.
	seedXViewReqForKey(t, db, "beta-snapshot", "xv-key-beta", "beta-model", "openai", 200, false, 200, 20, 2, now)

	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "xview-team.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "xview-team-jwt-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAuthSession(ctx, "xv-team-session", "xv-team-admin", "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	token, err := server.signAccessToken(accessClaims{
		Subject: "xv-team-admin", Role: "team_admin", TeamID: "team-alpha-id", Scopes: []string{"admin:read"},
		SessionID: "xv-team-session", Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	get := func(authToken, path string, out any) int {
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+authToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if out != nil {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}

	var snapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(token, "/admin/scatter?window=1h&limit=10", &snapshot); status != http.StatusOK {
		t.Fatalf("snapshot status = %d", status)
	}
	if len(snapshot.Points) != 1 || snapshot.Points[0].RequestID != "alpha-snapshot" || snapshot.Cursor.RequestID != "alpha-snapshot" {
		t.Fatalf("team-scoped snapshot leaked another team: %+v", snapshot)
	}
	var ownDetail map[string]any
	if status := get(token, "/admin/requests/alpha-snapshot", &ownDetail); status != http.StatusOK {
		t.Fatalf("team admin could not open a request stored under its team name: status=%d", status)
	}

	seedXViewReqForKey(t, db, "alpha-delta", "xv-key-alpha", "alpha-model", "openai", 200, false, 110, 11, 1.1, now)
	seedXViewReqForKey(t, db, "beta-delta", "xv-key-beta", "beta-model", "openai", 200, false, 210, 21, 2.1, now)
	query := url.Values{
		"window":            {"1h"},
		"after_ingested_at": {snapshot.Cursor.IngestedAt},
		"after_request_id":  {snapshot.Cursor.RequestID},
		"limit":             {"10"},
	}
	var delta struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(token, "/admin/xview/delta?"+query.Encode(), &delta); status != http.StatusOK {
		t.Fatalf("delta status = %d", status)
	}
	if len(delta.Points) != 1 || delta.Points[0].RequestID != "alpha-delta" || delta.Cursor.RequestID != "alpha-delta" {
		t.Fatalf("team-scoped delta leaked another team: %+v", delta)
	}

	var models struct {
		Models []store.ScatterModelGroup `json:"models"`
	}
	if status := get(token, "/admin/xview/models?window=1h&top=10", &models); status != http.StatusOK {
		t.Fatalf("models status = %d", status)
	}
	if len(models.Models) != 1 || models.Models[0].Model != "alpha-model" {
		t.Fatalf("team-scoped model analytics leaked another team: %+v", models.Models)
	}

	// A malformed or legacy team_admin account without a team must fail closed. Empty Team
	// cannot retain its old meaning of "no filter", because that would expose every tenant.
	if err := db.InsertAuthSession(ctx, "xv-empty-team-session", "xv-empty-team-admin", "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	emptyTeamToken, err := server.signAccessToken(accessClaims{
		Subject: "xv-empty-team-admin", Role: "team_admin", Scopes: []string{"admin:read"},
		SessionID: "xv-empty-team-session", Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	var emptySnapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(emptyTeamToken, "/admin/scatter?window=1h&limit=10", &emptySnapshot); status != http.StatusOK {
		t.Fatalf("empty-team snapshot status = %d", status)
	}
	if len(emptySnapshot.Points) != 0 || emptySnapshot.Cursor != (store.ScatterCursor{}) {
		t.Fatalf("empty-team admin must see no snapshot rows or cursor: %+v", emptySnapshot)
	}
	var emptyDelta struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(emptyTeamToken, "/admin/xview/delta?window=1h&refresh=true", &emptyDelta); status != http.StatusOK {
		t.Fatalf("empty-team delta status = %d", status)
	}
	if len(emptyDelta.Points) != 0 || emptyDelta.Cursor != (store.ScatterCursor{}) {
		t.Fatalf("empty-team admin must see no delta rows or cursor: %+v", emptyDelta)
	}
	var emptyModels struct {
		Models []store.ScatterModelGroup `json:"models"`
	}
	if status := get(emptyTeamToken, "/admin/xview/models?window=1h&top=10", &emptyModels); status != http.StatusOK {
		t.Fatalf("empty-team models status = %d", status)
	}
	if len(emptyModels.Models) != 0 {
		t.Fatalf("empty-team admin leaked model analytics: %+v", emptyModels.Models)
	}
	var emptyRequests struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if status := get(emptyTeamToken, "/admin/requests?limit=10", &emptyRequests); status != http.StatusOK {
		t.Fatalf("empty-team requests status = %d", status)
	}
	if len(emptyRequests.Requests) != 0 {
		t.Fatalf("empty-team admin leaked request rows: %+v", emptyRequests.Requests)
	}
}

func TestXViewTeamScopeRejectsAmbiguousAliasesAndSyntheticUnassigned(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	for _, team := range []store.AuthTeam{
		// team-a's name collides with team-b's canonical id. The raw value
		// "team-b" cannot safely be attributed to either team.
		{ID: "team-a", Name: "team-b"},
		{ID: "team-b", Name: "bravo"},
		{ID: "team-c", Name: "unassigned"},
	} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []store.APIKeyRecord{
		{ID: "scope-key-a", Name: "a", KeyHash: "scope-hash-a", Team: "team-a", Status: "active"},
		{ID: "scope-key-ambiguous", Name: "ambiguous", KeyHash: "scope-hash-ambiguous", Team: "team-b", Status: "active"},
		{ID: "scope-key-b-name", Name: "b-name", KeyHash: "scope-hash-b-name", Team: "bravo", Status: "active"},
		{ID: "scope-key-c-id", Name: "c-id", KeyHash: "scope-hash-c-id", Team: "team-c", Status: "active"},
		{ID: "scope-key-c-name", Name: "c-name", KeyHash: "scope-hash-c-name", Team: "unassigned", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	seedXViewReqForKey(t, db, "scope-a-snapshot", "scope-key-a", "a-model", "openai", 200, false, 100, 10, 1, now)
	seedXViewReqForKey(t, db, "scope-ambiguous-snapshot", "scope-key-ambiguous", "ambiguous-model", "openai", 200, false, 200, 20, 2, now)
	seedXViewReqForKey(t, db, "scope-b-name-snapshot", "scope-key-b-name", "b-model", "openai", 200, false, 300, 30, 3, now)
	seedXViewReqForKey(t, db, "scope-c-id-snapshot", "scope-key-c-id", "c-model", "openai", 200, false, 400, 40, 4, now)
	seedXViewReqForKey(t, db, "scope-c-name-snapshot", "scope-key-c-name", "c-model", "openai", 200, false, 410, 41, 4.1, now)
	seedXViewReqForKey(t, db, "scope-synthetic-unassigned", "missing-key", "synthetic-model", "openai", 200, false, 500, 50, 5, now)

	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "xview-team-collision.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "xview-team-collision-jwt-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	issueToken := func(subject, teamID string) string {
		t.Helper()
		sessionID := subject + "-session"
		if err := db.InsertAuthSession(ctx, sessionID, subject, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		token, err := server.signAccessToken(accessClaims{
			Subject: subject, Role: "team_admin", TeamID: teamID, Scopes: []string{"admin:read"},
			SessionID: sessionID, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	get := func(token, path string, out any) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if out != nil {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	pointIDs := func(points []store.ScatterPoint) map[string]bool {
		ids := make(map[string]bool, len(points))
		for _, point := range points {
			ids[point.RequestID] = true
		}
		return ids
	}
	requestIDs := func(requests []store.RecentRequest) map[string]bool {
		ids := make(map[string]bool, len(requests))
		for _, request := range requests {
			ids[request.ID] = true
		}
		return ids
	}

	aToken := issueToken("scope-admin-a", "team-a")
	var aSnapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(aToken, "/admin/scatter?window=1h&limit=20", &aSnapshot); status != http.StatusOK {
		t.Fatalf("team-a snapshot status = %d", status)
	}
	if ids := pointIDs(aSnapshot.Points); len(ids) != 1 || !ids["scope-a-snapshot"] || aSnapshot.Cursor.RequestID != "scope-a-snapshot" {
		t.Fatalf("team-a snapshot used an ambiguous alias: points=%v cursor=%+v", ids, aSnapshot.Cursor)
	}
	seedXViewReqForKey(t, db, "scope-ambiguous-delta", "scope-key-ambiguous", "ambiguous-model", "openai", 200, false, 220, 22, 2.2, now)
	seedXViewReqForKey(t, db, "scope-a-delta", "scope-key-a", "a-model", "openai", 200, false, 120, 12, 1.2, now)
	query := url.Values{
		"window":            {"1h"},
		"after_ingested_at": {aSnapshot.Cursor.IngestedAt},
		"after_request_id":  {aSnapshot.Cursor.RequestID},
		"limit":             {"20"},
	}
	var aDelta struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(aToken, "/admin/xview/delta?"+query.Encode(), &aDelta); status != http.StatusOK {
		t.Fatalf("team-a delta status = %d", status)
	}
	if ids := pointIDs(aDelta.Points); len(ids) != 1 || !ids["scope-a-delta"] || aDelta.Cursor.RequestID != "scope-a-delta" {
		t.Fatalf("team-a delta used an ambiguous alias: points=%v cursor=%+v", ids, aDelta.Cursor)
	}
	var aModels struct {
		Models []store.ScatterModelGroup `json:"models"`
	}
	if status := get(aToken, "/admin/xview/models?window=1h&top=10", &aModels); status != http.StatusOK {
		t.Fatalf("team-a models status = %d", status)
	}
	if len(aModels.Models) != 1 || aModels.Models[0].Model != "a-model" {
		t.Fatalf("team-a model analytics used an ambiguous alias: %+v", aModels.Models)
	}
	var aRequests struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if status := get(aToken, "/admin/requests?limit=20", &aRequests); status != http.StatusOK {
		t.Fatalf("team-a requests status = %d", status)
	}
	if ids := requestIDs(aRequests.Requests); len(ids) != 2 || !ids["scope-a-snapshot"] || !ids["scope-a-delta"] {
		t.Fatalf("team-a request list used an ambiguous alias: %v", ids)
	}
	if status := get(aToken, "/admin/requests/scope-ambiguous-snapshot", &map[string]any{}); status != http.StatusForbidden {
		t.Fatalf("team-a ambiguous request detail status = %d, want 403", status)
	}

	// The ambiguous literal cannot be used as a caller identity either. Team B remains
	// reachable through its unambiguous display name, but only its unambiguous key alias.
	ambiguousToken := issueToken("scope-admin-ambiguous", "team-b")
	var ambiguousSnapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(ambiguousToken, "/admin/scatter?window=1h&limit=20", &ambiguousSnapshot); status != http.StatusOK {
		t.Fatalf("ambiguous caller snapshot status = %d", status)
	}
	if len(ambiguousSnapshot.Points) != 0 || ambiguousSnapshot.Cursor != (store.ScatterCursor{}) {
		t.Fatalf("ambiguous caller identity must fail closed: %+v", ambiguousSnapshot)
	}
	bToken := issueToken("scope-admin-b-name", "bravo")
	var bSnapshot struct {
		Points []store.ScatterPoint `json:"points"`
	}
	if status := get(bToken, "/admin/scatter?window=1h&limit=20", &bSnapshot); status != http.StatusOK {
		t.Fatalf("team-b name snapshot status = %d", status)
	}
	if ids := pointIDs(bSnapshot.Points); len(ids) != 1 || !ids["scope-b-name-snapshot"] {
		t.Fatalf("team-b name scope included an ambiguous key alias: %v", ids)
	}

	// A real team display name may be the literal "unassigned". Scoped queries must
	// still use the api-key semi-join and never absorb missing-key synthetic traffic.
	cToken := issueToken("scope-admin-c", "team-c")
	var cSnapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if status := get(cToken, "/admin/scatter?window=1h&limit=20", &cSnapshot); status != http.StatusOK {
		t.Fatalf("team-c snapshot status = %d", status)
	}
	if ids := pointIDs(cSnapshot.Points); len(ids) != 2 || !ids["scope-c-id-snapshot"] || !ids["scope-c-name-snapshot"] || ids["scope-synthetic-unassigned"] {
		t.Fatalf("literal unassigned team scope leaked synthetic traffic: points=%v cursor=%+v", ids, cSnapshot.Cursor)
	}
	var cRequests struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if status := get(cToken, "/admin/requests?limit=20", &cRequests); status != http.StatusOK {
		t.Fatalf("team-c requests status = %d", status)
	}
	if ids := requestIDs(cRequests.Requests); len(ids) != 2 || !ids["scope-c-id-snapshot"] || !ids["scope-c-name-snapshot"] || ids["scope-synthetic-unassigned"] {
		t.Fatalf("literal unassigned request scope leaked synthetic traffic: %v", ids)
	}
	if status := get(cToken, "/admin/requests/scope-c-name-snapshot", &map[string]any{}); status != http.StatusOK {
		t.Fatalf("team-c could not open its literal unassigned alias request: status=%d", status)
	}
	if status := get(cToken, "/admin/requests/scope-synthetic-unassigned", &map[string]any{}); status != http.StatusForbidden {
		t.Fatalf("team-c synthetic request detail status = %d, want 403", status)
	}
}

func TestScatterMultiModelFilter(t *testing.T) {
	db, srv := xviewTestServer(t)
	now := time.Now().UTC()
	seedXViewReq(t, db, "m1a", "gpt-4.1", "openai", 200, false, 300, 100, 10, now)
	seedXViewReq(t, db, "m1b", "gpt-4.1", "openai", 200, false, 400, 120, 12, now)
	seedXViewReq(t, db, "m2a", "gpt-4.1-mini", "openai", 200, false, 100, 50, 2, now)
	seedXViewReq(t, db, "m3a", "claude-3-5-sonnet", "anthropic", 200, false, 500, 80, 5, now)

	// multi-model filter: only gpt-4.1 and gpt-4.1-mini
	resp, err := http.Get(srv.URL + "/admin/scatter?window=1h&models=gpt-4.1,gpt-4.1-mini&include_summary=true")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Points    []store.ScatterPoint      `json:"points"`
		Groups    []store.ScatterModelGroup `json:"groups"`
		Truncated bool                      `json:"truncated"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()

	if len(out.Points) != 3 {
		t.Fatalf("expected 3 points for 2 models, got %d", len(out.Points))
	}
	if len(out.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(out.Groups))
	}
	// gpt-4.1 should be first (higher count)
	if out.Groups[0].Model != "gpt-4.1" {
		t.Errorf("expected gpt-4.1 first by count, got %s", out.Groups[0].Model)
	}
	if out.Groups[0].Count != 2 {
		t.Errorf("gpt-4.1 count = %d, want 2", out.Groups[0].Count)
	}
	// check P50 is set
	if out.Groups[0].P50 <= 0 {
		t.Errorf("P50 should be > 0, got %d", out.Groups[0].P50)
	}
	// claude-3-5-sonnet should NOT appear in points (filtered out)
	for _, p := range out.Points {
		if p.Model == "claude-3-5-sonnet" {
			t.Errorf("claude-3-5-sonnet should be filtered out but appeared in points")
		}
	}
}

func TestScatterFromToDateRange(t *testing.T) {
	db, srv := xviewTestServer(t)
	// Three requests on distinct UTC days. "new" is at 03:00Z on Jul 28 == 12:00 KST Jul 28.
	seedXViewReq(t, db, "d-old", "gpt-4.1", "openai", 200, false, 300, 100, 10, time.Date(2026, 7, 1, 3, 0, 0, 0, time.UTC))
	seedXViewReq(t, db, "d-mid", "gpt-4.1", "openai", 200, false, 300, 100, 10, time.Date(2026, 7, 15, 3, 0, 0, 0, time.UTC))
	seedXViewReq(t, db, "d-new", "gpt-4.1", "openai", 200, false, 300, 100, 10, time.Date(2026, 7, 28, 3, 0, 0, 0, time.UTC))

	get := func(query string) []store.ScatterPoint {
		resp, err := http.Get(srv.URL + "/admin/scatter?" + query)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Points []store.ScatterPoint `json:"points"`
		}
		json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		return out.Points
	}
	ids := func(pts []store.ScatterPoint) map[string]bool {
		m := map[string]bool{}
		for _, p := range pts {
			m[p.RequestID] = true
		}
		return m
	}

	// from+to (default tz Asia/Seoul): only the mid request falls inside [Jul 10, Jul 20].
	got := ids(get("from=2026-07-10&to=2026-07-20"))
	if len(got) != 1 || !got["d-mid"] {
		t.Fatalf("from+to KST range = %v, want only d-mid", got)
	}

	// KST boundary: searching up to end of Jul 27 (KST) must exclude d-new (12:00 KST Jul 28).
	got = ids(get("to=2026-07-27"))
	if got["d-new"] {
		t.Errorf("to=2026-07-27 (KST) should exclude d-new; got %v", got)
	}
	if !got["d-old"] || !got["d-mid"] {
		t.Errorf("to=2026-07-27 should include d-old and d-mid; got %v", got)
	}

	// Same "to" interpreted in UTC still excludes d-new (03:00Z Jul 28 > end of Jul 27 UTC).
	got = ids(get("to=2026-07-27&tz=UTC"))
	if got["d-new"] || !got["d-mid"] {
		t.Errorf("to=2026-07-27 UTC unexpected: %v", got)
	}

	// from only leaves the upper bound open → mid + new.
	got = ids(get("from=2026-07-10"))
	if got["d-old"] || !got["d-mid"] || !got["d-new"] {
		t.Errorf("from-only range = %v, want mid+new", got)
	}
}

func TestXViewDeltaEndpointTracksLateCommitsFromSnapshotCursor(t *testing.T) {
	db, srv := xviewTestServer(t)
	now := time.Now().UTC()
	seedXViewReq(t, db, "delta-fast", "gpt-4.1", "openai", 200, false, 100, 10, 1, now)

	resp, err := http.Get(srv.URL + "/admin/scatter?window=1h&limit=10")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Points []store.ScatterPoint `json:"points"`
		Cursor store.ScatterCursor  `json:"cursor"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(snapshot.Points) != 1 || snapshot.Points[0].IngestedAt == "" {
		t.Fatalf("snapshot missing ingestion metadata: %+v", snapshot)
	}
	if snapshot.Cursor.IngestedAt == "" || snapshot.Cursor.RequestID == "" {
		t.Fatalf("snapshot missing delta cursor: %+v", snapshot.Cursor)
	}

	// It started before the snapshot row but commits after the snapshot cursor.
	seedXViewReq(t, db, "delta-slow", "gpt-4.1", "openai", 200, false, 300, 20, 2, now.Add(-30*time.Minute))
	query := url.Values{
		"window":            {"1h"},
		"models":            {"gpt-4.1"},
		"after_ingested_at": {snapshot.Cursor.IngestedAt},
		"after_request_id":  {snapshot.Cursor.RequestID},
		"limit":             {"10"},
	}
	resp, err = http.Get(srv.URL + "/admin/xview/delta?" + query.Encode())
	if err != nil {
		t.Fatal(err)
	}
	var delta struct {
		Points  []store.ScatterPoint `json:"points"`
		Cursor  store.ScatterCursor  `json:"cursor"`
		HasMore bool                 `json:"has_more"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&delta); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || delta.HasMore || len(delta.Points) != 1 || delta.Points[0].RequestID != "delta-slow" {
		t.Fatalf("delta response status=%d payload=%+v", resp.StatusCode, delta)
	}
	if delta.Cursor.RequestID != "delta-slow" || delta.Cursor.IngestedAt != delta.Points[0].IngestedAt {
		t.Fatalf("delta cursor did not advance: %+v", delta)
	}
}

func TestXViewDeltaEndpointValidatesCursorAndMethod(t *testing.T) {
	_, srv := xviewTestServer(t)
	cases := []string{
		"after_ingested_at=2026-08-25T00%3A00%3A00Z",
		"after_request_id=req-only",
		"after_ingested_at=not-a-time&after_request_id=req-bad",
		"reconcile=eventually",
		"refresh=eventually",
	}
	for _, query := range cases {
		resp, err := http.Get(srv.URL + "/admin/xview/delta?" + query)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("query %q status = %d, want 400", query, resp.StatusCode)
		}
	}

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/admin/xview/delta", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", resp.StatusCode)
	}
}

func TestXViewDeltaEndpointRequiresAdminToken(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "xview-auth.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.AdminToken = "xview-admin"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/admin/xview/delta")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", resp.StatusCode)
	}
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/admin/xview/delta", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer xview-admin")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated status = %d, want 200", resp.StatusCode)
	}
}

func TestXViewModelsEndpoint(t *testing.T) {
	db, srv := xviewTestServer(t)
	now := time.Now().UTC()
	for i := 0; i < 5; i++ {
		seedXViewReq(t, db, "a"+itoaT(i), "gpt-4.1", "openai", 200, false, int64(100+i*50), 100, 10, now)
	}
	seedXViewReq(t, db, "b1", "gpt-4.1-mini", "openai", 500, false, 80, 50, 2, now)
	seedXViewReq(t, db, "b2", "gpt-4.1-mini", "openai", 200, true, 90, 55, 2.5, now)

	resp, err := http.Get(srv.URL + "/admin/xview/models?window=1h&top=5")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Models []store.ScatterModelGroup `json:"models"`
		Top    int                       `json:"top"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()

	if len(out.Models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(out.Models))
	}
	if out.Models[0].Model != "gpt-4.1" {
		t.Errorf("expected gpt-4.1 first, got %s", out.Models[0].Model)
	}
	if out.Models[0].Count != 5 {
		t.Errorf("gpt-4.1 count = %d, want 5", out.Models[0].Count)
	}
	// gpt-4.1-mini: 1 error (500), 1 failover
	var mini store.ScatterModelGroup
	for _, m := range out.Models {
		if m.Model == "gpt-4.1-mini" {
			mini = m
		}
	}
	if mini.Count != 2 {
		t.Errorf("gpt-4.1-mini count = %d, want 2", mini.Count)
	}
	if mini.ErrorRate < 0.49 || mini.ErrorRate > 0.51 {
		t.Errorf("gpt-4.1-mini error_rate = %f, want ~0.5", mini.ErrorRate)
	}
	if mini.FailoverCount != 1 {
		t.Errorf("gpt-4.1-mini failover_count = %d, want 1", mini.FailoverCount)
	}
}

func TestXViewModelSeriesEndpoint(t *testing.T) {
	db, srv := xviewTestServer(t)
	now := time.Now().UTC()
	seedXViewReq(t, db, "s1", "gpt-4.1", "openai", 200, false, 200, 100, 10, now)
	seedXViewReq(t, db, "s2", "gpt-4.1", "openai", 500, false, 300, 0, 0, now)
	seedXViewReq(t, db, "s3", "gpt-4.1-mini", "openai", 200, false, 80, 50, 2, now)

	resp, err := http.Get(srv.URL + "/admin/xview/model-series?window=1h&bucket=hour")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Series map[string][]struct {
			Ts         string  `json:"ts"`
			Count      int64   `json:"count"`
			ErrorRate  float64 `json:"error_rate"`
			AvgLatency float64 `json:"avg_latency_ms"`
		} `json:"series"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()

	if len(out.Series) < 2 {
		t.Fatalf("expected series for at least 2 models, got %d", len(out.Series))
	}
	gptSeries := out.Series["gpt-4.1"]
	if len(gptSeries) == 0 {
		t.Fatal("expected at least 1 bucket for gpt-4.1")
	}
	if gptSeries[0].Count != 2 {
		t.Errorf("gpt-4.1 bucket count = %d, want 2", gptSeries[0].Count)
	}
}

func TestXViewModelOutliersEndpoint(t *testing.T) {
	db, srv := xviewTestServer(t)
	now := time.Now().UTC()
	// 20 normal requests (100–290ms) so P95 stays well below 30000ms
	for i := 0; i < 20; i++ {
		seedXViewReq(t, db, "n"+itoaT(i), "gpt-4.1", "openai", 200, false, int64(100+i*10), 100, 10, now)
	}
	// outlier: latency far above P95 of the normal distribution
	seedXViewReq(t, db, "slow1", "gpt-4.1", "openai", 200, false, 30000, 200, 20, now)
	// error
	seedXViewReq(t, db, "err1", "gpt-4.1", "openai", 500, false, 200, 0, 0, now)
	// failover
	seedXViewReq(t, db, "fo1", "gpt-4.1", "openai", 200, true, 150, 100, 10, now)

	resp, err := http.Get(srv.URL + "/admin/xview/model-outliers?window=1h")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Outliers []struct {
			RequestID string   `json:"request_id"`
			Tags      []string `json:"tags"`
		} `json:"outliers"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()

	if len(out.Outliers) < 3 {
		t.Fatalf("expected >=3 outliers (slow+error+failover), got %d", len(out.Outliers))
	}
	tagsByID := map[string][]string{}
	for _, o := range out.Outliers {
		tagsByID[o.RequestID] = o.Tags
	}
	hasTag := func(id, tag string) bool {
		for _, t := range tagsByID[id] {
			if t == tag {
				return true
			}
		}
		return false
	}
	if !hasTag("slow1", "p95_exceeded") {
		t.Errorf("slow1 should have p95_exceeded tag, got %v", tagsByID["slow1"])
	}
	if !hasTag("err1", "error_5xx") {
		t.Errorf("err1 should have error_5xx tag, got %v", tagsByID["err1"])
	}
	if !hasTag("fo1", "failover") {
		t.Errorf("fo1 should have failover tag, got %v", tagsByID["fo1"])
	}
}
