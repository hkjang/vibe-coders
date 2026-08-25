package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{
			ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
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
