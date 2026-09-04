package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// buildWaterfallSession inserts a 4-request session with deterministic timing and
// returns the store. Spans: normal, complex, cache(latency 0), error.
func buildWaterfallSession(t *testing.T) (*store.SQLStore, time.Time) {
	t.Helper()
	db := openTestStore(t)
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)

	mk := func(id string, offset time.Duration, latency, firstChunk int64, status, complexity int, provider, routeReason string) {
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, SessionID: "wf-1", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Provider: provider, StatusCode: status,
				LatencyMS: latency, FirstChunkMS: firstChunk, Complexity: complexity,
				RouteReason: routeReason, CreatedAt: base.Add(offset),
			},
			Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: 5, Currency: "KRW", Source: "usage", CreatedAt: base.Add(offset)},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mk("r1", 0, 100, 40, 200, 10, "openai", "default")             // normal
	mk("r2", 2*time.Second, 200, 80, 200, 90, "openai", "default") // complex
	mk("r3", 3*time.Second, 0, 0, 200, 5, "cache", "cache")        // cache hit
	mk("r4", 4*time.Second, 150, 60, 500, 5, "openai", "default")  // error
	return db, base
}

func TestWaterfallStoreComputesSpans(t *testing.T) {
	db, _ := buildWaterfallSession(t)
	defer db.Close()

	tr, err := db.Waterfall(context.Background(), "wf-1", 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Requests != 4 {
		t.Fatalf("expected 4 spans, got %d", tr.Requests)
	}

	// offsets relative to first request
	wantOffset := []int64{0, 2000, 3000, 4000}
	wantGap := []int64{0, 1900, 800, 1000}
	wantCat := []string{"normal", "complex", "cache", "error"}
	wantTTFB := []int64{40, 80, 0, 60}
	wantTotal := []int64{100, 200, 0, 150}
	for i, sp := range tr.Spans {
		if sp.Seq != i+1 {
			t.Errorf("span %d: seq=%d", i, sp.Seq)
		}
		if sp.StartOffsetMS != wantOffset[i] {
			t.Errorf("span %d: start_offset=%d want %d", i, sp.StartOffsetMS, wantOffset[i])
		}
		if sp.GapBeforeMS != wantGap[i] {
			t.Errorf("span %d: gap=%d want %d", i, sp.GapBeforeMS, wantGap[i])
		}
		if sp.Category != wantCat[i] {
			t.Errorf("span %d: category=%q want %q", i, sp.Category, wantCat[i])
		}
		if sp.TTFBMS != wantTTFB[i] {
			t.Errorf("span %d: ttfb=%d want %d", i, sp.TTFBMS, wantTTFB[i])
		}
		if sp.TotalMS != wantTotal[i] {
			t.Errorf("span %d: total=%d want %d", i, sp.TotalMS, wantTotal[i])
		}
	}

	// wall = last end = 4000+150 = 4150
	if tr.WallMS != 4150 {
		t.Errorf("wall_ms=%d want 4150", tr.WallMS)
	}
	// busy = union of [0,100],[2000,2200],[3000,3000],[4000,4150] = 450
	if tr.BusyMS != 450 {
		t.Errorf("busy_ms=%d want 450", tr.BusyMS)
	}
	if tr.IdleMS != 3700 {
		t.Errorf("idle_ms=%d want 3700", tr.IdleMS)
	}
	if tr.Categories["error"] != 1 || tr.Categories["cache"] != 1 || tr.Categories["complex"] != 1 || tr.Categories["normal"] != 1 {
		t.Errorf("unexpected categories: %+v", tr.Categories)
	}
	if tr.TotalCostKRW != 20 || tr.TotalTokens != 40 {
		t.Errorf("totals: cost=%.0f tokens=%d", tr.TotalCostKRW, tr.TotalTokens)
	}

	// phase totals: wait = Σ ttfb (40+80+0+60), stream = Σ (total-ttfb)
	if tr.WaitMS != 180 {
		t.Errorf("wait_ms=%d want 180", tr.WaitMS)
	}
	if tr.StreamMS != 270 {
		t.Errorf("stream_ms=%d want 270", tr.StreamMS)
	}
	// bottleneck: slowest = r2 (200ms), longest gap = before r2 (1900ms)
	if tr.Bottleneck.SlowestSeq != 2 || tr.Bottleneck.SlowestMS != 200 {
		t.Errorf("slowest: seq=%d ms=%d want seq2/200", tr.Bottleneck.SlowestSeq, tr.Bottleneck.SlowestMS)
	}
	if tr.Bottleneck.LongestGapSeq != 2 || tr.Bottleneck.LongestGapMS != 1900 {
		t.Errorf("longest gap: seq=%d ms=%d want seq2/1900", tr.Bottleneck.LongestGapSeq, tr.Bottleneck.LongestGapMS)
	}
	// slow threshold auto-falls back to the 3000ms floor here (p95=200 < 3000) → no slow spans
	if tr.SlowMS != 3000 || tr.SlowCount != 0 {
		t.Errorf("auto slow: slow_ms=%d count=%d want 3000/0", tr.SlowMS, tr.SlowCount)
	}
}

func TestWaterfallSlowFlag(t *testing.T) {
	db, _ := buildWaterfallSession(t)
	defer db.Close()

	// explicit threshold 150ms → r2(200) and r4(150) are slow, r1(100)/r3(0) are not
	tr, err := db.Waterfall(context.Background(), "wf-1", 100, 150)
	if err != nil {
		t.Fatal(err)
	}
	if tr.SlowMS != 150 {
		t.Fatalf("slow_ms=%d want 150", tr.SlowMS)
	}
	if tr.SlowCount != 2 {
		t.Fatalf("slow_count=%d want 2", tr.SlowCount)
	}
	want := []bool{false, true, false, true}
	for i, sp := range tr.Spans {
		if sp.Slow != want[i] {
			t.Errorf("span %d (total %dms): slow=%v want %v", i, sp.TotalMS, sp.Slow, want[i])
		}
	}
}

func TestWaterfallTTFBClampedToTotal(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	// first_chunk_ms larger than latency_ms (shouldn't happen, but guard anyway)
	if err := db.InsertLogRecord(ctx, store.LogRecord{
		Request: store.RequestLog{ID: "c1", TraceID: "c1", SessionID: "wf-clamp", Endpoint: "/v1/chat/completions",
			Model: "gpt-4.1", StatusCode: 200, LatencyMS: 50, FirstChunkMS: 999, CreatedAt: base},
	}); err != nil {
		t.Fatal(err)
	}
	tr, err := db.Waterfall(ctx, "wf-clamp", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Spans[0].TTFBMS != 50 {
		t.Fatalf("ttfb should be clamped to total 50, got %d", tr.Spans[0].TTFBMS)
	}
}

func TestWaterfallEndpoint(t *testing.T) {
	db, _ := buildWaterfallSession(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// missing session_id → 400
	bad, err := http.Get(proxy.URL + "/admin/waterfall")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without session_id, got %d", bad.StatusCode)
	}

	resp, err := http.Get(proxy.URL + "/admin/waterfall?session_id=wf-1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var tr store.WaterfallTrace
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		t.Fatal(err)
	}
	if tr.SessionID != "wf-1" || len(tr.Spans) != 4 {
		t.Fatalf("unexpected trace: session=%q spans=%d", tr.SessionID, len(tr.Spans))
	}
	if tr.Spans[3].Category != "error" {
		t.Fatalf("last span category=%q want error", tr.Spans[3].Category)
	}

	post, err := http.Post(proxy.URL+"/admin/waterfall?session_id=wf-1", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	post.Body.Close()
	if post.StatusCode != http.StatusMethodNotAllowed || post.Header.Get("Allow") != http.MethodGet {
		t.Fatalf("POST waterfall status=%d Allow=%q", post.StatusCode, post.Header.Get("Allow"))
	}
}

func TestWaterfallEndpointScopesTeamAndProjectsLowerRoleMetadata(t *testing.T) {
	db, proxy := newAuthTestServer(t, "http://example.invalid")
	defer proxy.Close()

	login := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{
		"email": "root@example.com", "password": "correct-password",
	})
	var rootToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(login.Body).Decode(&rootToken); err != nil {
		t.Fatal(err)
	}
	login.Body.Close()

	for _, team := range []map[string]string{
		{"id": "waterfall-team-alpha", "name": "Waterfall Alpha"},
		{"id": "waterfall-team-beta", "name": "Waterfall Beta"},
	} {
		response := postJSON(t, proxy.URL+"/admin/teams", rootToken.AccessToken, team)
		response.Body.Close()
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("create team %q status=%d", team["id"], response.StatusCode)
		}
	}
	teamAdmin := postJSON(t, proxy.URL+"/admin/users", rootToken.AccessToken, map[string]string{
		"email": "waterfall-admin@example.com", "password": "waterfall-password",
		"role": "team_admin", "team_id": "waterfall-team-alpha",
	})
	teamAdmin.Body.Close()
	if teamAdmin.StatusCode != http.StatusCreated {
		t.Fatalf("create team admin status=%d", teamAdmin.StatusCode)
	}
	teamLogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{
		"email": "waterfall-admin@example.com", "password": "waterfall-password",
	})
	var teamToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(teamLogin.Body).Decode(&teamToken); err != nil {
		t.Fatal(err)
	}
	teamLogin.Body.Close()

	for _, key := range []store.APIKeyRecord{
		{ID: "waterfall-alpha-key", Name: "alpha", Team: "waterfall-team-alpha", KeyHash: "waterfall-alpha-hash", Status: "active"},
		{ID: "waterfall-beta-key", Name: "beta", Team: "waterfall-team-beta", KeyHash: "waterfall-beta-hash", Status: "active"},
	} {
		if err := db.UpsertAPIKey(t.Context(), key); err != nil {
			t.Fatal(err)
		}
	}
	unsafeProvider := "vc_sk_" + strings.Repeat("A", 32)
	unsafeFallback := "vc_sa_" + strings.Repeat("B", 32)
	unsafeTrace := "waterfall-trace-owner@example.com"
	unsafeModel := "waterfall-model-owner@example.com"
	unsafeRequestedModel := "010-1234-5678"
	unsafeEndpoint := "/v1/waterfall-owner@example.com"
	now := time.Now().UTC().Add(-time.Minute)
	for _, record := range []store.RequestLog{
		{
			ID: "waterfall-alpha-request", TraceID: unsafeTrace, APIKeyID: "waterfall-alpha-key",
			SessionID: "waterfall-shared-session", Model: unsafeModel, RequestedModel: unsafeRequestedModel,
			Provider: unsafeProvider, FallbackFrom: unsafeFallback, Endpoint: unsafeEndpoint,
			StatusCode: http.StatusOK, LatencyMS: 10, CreatedAt: now,
		},
		{
			ID: "waterfall-beta-request", TraceID: "waterfall-beta-private@example.com", APIKeyID: "waterfall-beta-key",
			SessionID: "waterfall-shared-session", Model: "beta-model", Provider: "beta-provider",
			Endpoint: "/v1/chat/completions", StatusCode: http.StatusOK, LatencyMS: 10, CreatedAt: now.Add(time.Second),
		},
	} {
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: record}); err != nil {
			t.Fatal(err)
		}
	}

	get := func(token string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, proxy.URL+"/admin/waterfall?session_id=waterfall-shared-session", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}

	teamStatus, teamBody := get(teamToken.AccessToken)
	if teamStatus != http.StatusOK || !strings.Contains(string(teamBody), "waterfall-alpha-request") {
		t.Fatalf("team waterfall lost own request: status=%d body=%s", teamStatus, teamBody)
	}
	for _, forbidden := range []string{
		"waterfall-beta-request", "waterfall-beta-private@example.com", unsafeProvider,
		unsafeFallback, unsafeTrace, unsafeModel, unsafeRequestedModel, unsafeEndpoint,
	} {
		if strings.Contains(string(teamBody), forbidden) {
			t.Fatalf("team waterfall exposed %q: %s", forbidden, teamBody)
		}
	}
	if !strings.Contains(string(teamBody), providerNameOmitted) || !strings.Contains(string(teamBody), "[REDACTED_EMAIL]") {
		t.Fatalf("team waterfall did not apply lower-role projection: %s", teamBody)
	}

	rootStatus, rootBody := get(rootToken.AccessToken)
	if rootStatus != http.StatusOK {
		t.Fatalf("root waterfall status=%d body=%s", rootStatus, rootBody)
	}
	for _, preserved := range []string{"waterfall-alpha-request", "waterfall-beta-request", unsafeProvider, unsafeFallback, unsafeTrace, unsafeModel, unsafeRequestedModel, unsafeEndpoint} {
		if !strings.Contains(string(rootBody), preserved) {
			t.Fatalf("unrestricted waterfall lost %q: %s", preserved, rootBody)
		}
	}

	emptyAdmin := postJSON(t, proxy.URL+"/admin/users", rootToken.AccessToken, map[string]string{
		"email": "waterfall-empty@example.com", "password": "waterfall-password", "role": "team_admin",
	})
	emptyAdmin.Body.Close()
	if emptyAdmin.StatusCode != http.StatusCreated {
		t.Fatalf("create empty-scope team admin status=%d", emptyAdmin.StatusCode)
	}
	emptyLogin := postJSON(t, proxy.URL+"/auth/login", "", map[string]string{
		"email": "waterfall-empty@example.com", "password": "waterfall-password",
	})
	var emptyToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(emptyLogin.Body).Decode(&emptyToken); err != nil {
		t.Fatal(err)
	}
	emptyLogin.Body.Close()
	emptyStatus, emptyBody := get(emptyToken.AccessToken)
	if emptyStatus != http.StatusOK {
		t.Fatalf("empty-scope waterfall status=%d body=%s", emptyStatus, emptyBody)
	}
	var emptyTrace store.WaterfallTrace
	if err := json.Unmarshal(emptyBody, &emptyTrace); err != nil {
		t.Fatal(err)
	}
	if emptyTrace.Requests != 0 || len(emptyTrace.Spans) != 0 {
		t.Fatalf("empty team scope did not fail closed: %+v", emptyTrace)
	}
}

func TestWaterfallEndpointDoesNotExposeDatabaseErrors(t *testing.T) {
	db := openTestStore(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	server := &Server{db: db}
	request := httptest.NewRequest(http.MethodGet, "/admin/waterfall?session_id=waterfall-db-error", nil)
	recorder := httptest.NewRecorder()
	server.handleWaterfall(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("waterfall DB failure status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(strings.ToLower(recorder.Body.String()), "database") || strings.Contains(strings.ToLower(recorder.Body.String()), "closed") {
		t.Fatalf("waterfall reflected database error: %s", recorder.Body.String())
	}
}

func TestWaterfallProjectionUsesConfiguredCredentialPrefixAndPreservesFullAdmin(t *testing.T) {
	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AdminToken = "waterfall-full-admin"
	cfg.Auth.AdminReadonlyToken = "waterfall-readonly"
	cfg.Auth.APIKeyPrefix = "corp_"
	server := &Server{cfg: cfg}
	credential := "corp_" + strings.Repeat("C", 43)
	newTrace := func() store.WaterfallTrace {
		return store.WaterfallTrace{
			SessionID: credential, StartedAt: credential,
			Spans: []store.WaterfallSpan{{
				RequestID: credential, TraceID: credential, Model: credential, RequestedModel: credential,
				Provider: credential, Endpoint: credential, Category: credential, FallbackFrom: credential,
				CreatedAt: credential,
			}},
		}
	}
	request := func(token string) *http.Request {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/admin/waterfall?session_id=projection", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return r
	}

	readonly := newTrace()
	server.projectWaterfallForExternal(request("waterfall-readonly"), &readonly)
	encoded, err := json.Marshal(readonly)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), credential) {
		t.Fatalf("readonly waterfall leaked configured credential prefix: %s", encoded)
	}
	if readonly.Spans[0].Provider != providerNameOmitted || readonly.Spans[0].FallbackFrom != providerNameOmitted {
		t.Fatalf("readonly provider labels were not omitted: %+v", readonly.Spans[0])
	}

	full := newTrace()
	server.projectWaterfallForExternal(request("waterfall-full-admin"), &full)
	if full.SessionID != credential || full.Spans[0].Provider != credential || full.Spans[0].CreatedAt != credential {
		t.Fatalf("full admin waterfall did not preserve raw metadata: %+v", full)
	}
}
