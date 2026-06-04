package proxy

import (
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

func TestAnalyticsEndpointsReturnPopulatedSummaries(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
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

	// create a key so top_users has something to show
	if resp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{"name": "A", "key": "alpha"}); resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("api key create failed: %d %s", resp.StatusCode, body)
	}

	for i := 0; i < 3; i++ {
		r := postJSON(t, proxy.URL+"/v1/chat/completions", "alpha", chatBody("test-model", false))
		if r.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(r.Body)
			t.Fatalf("call %d failed: %d %s", i, r.StatusCode, body)
		}
		r.Body.Close()
	}

	waitFor(t, time.Second, func() bool {
		s, err := db.Summary(context.Background())
		return err == nil && s.TotalRequests == 3
	})

	// stats now includes by_status and top_users
	statsResp, err := http.Get(proxy.URL + "/admin/stats")
	if err != nil {
		t.Fatal(err)
	}
	defer statsResp.Body.Close()
	var stats store.SummaryStats
	if err := json.NewDecoder(statsResp.Body).Decode(&stats); err != nil {
		t.Fatal(err)
	}
	if stats.TotalRequests != 3 {
		t.Fatalf("expected 3 total, got %d", stats.TotalRequests)
	}
	if len(stats.ByStatus) == 0 {
		t.Fatal("expected by_status to be populated")
	}
	if len(stats.TopUsers) == 0 {
		t.Fatal("expected top_users to be populated")
	}
	if stats.TopUsers[0].Requests != 3 {
		t.Fatalf("expected top user requests=3, got %d", stats.TopUsers[0].Requests)
	}

	// timeseries
	tsResp, err := http.Get(proxy.URL + "/admin/timeseries?window=24h&bucket=hour")
	if err != nil {
		t.Fatal(err)
	}
	defer tsResp.Body.Close()
	var ts struct {
		Bucket string                  `json:"bucket"`
		Points []store.TimeseriesPoint `json:"points"`
	}
	if err := json.NewDecoder(tsResp.Body).Decode(&ts); err != nil {
		t.Fatal(err)
	}
	if ts.Bucket != "hour" {
		t.Fatalf("expected bucket=hour, got %s", ts.Bucket)
	}
	if len(ts.Points) == 0 {
		t.Fatal("expected at least one timeseries point")
	}
	var sumReq int64
	for _, p := range ts.Points {
		sumReq += p.Requests
	}
	if sumReq != 3 {
		t.Fatalf("expected timeseries to account for 3 requests, got %d", sumReq)
	}

	// heatmap
	heatResp, err := http.Get(proxy.URL + "/admin/heatmap?window=7d")
	if err != nil {
		t.Fatal(err)
	}
	defer heatResp.Body.Close()
	var heat store.Heatmap
	if err := json.NewDecoder(heatResp.Body).Decode(&heat); err != nil {
		t.Fatal(err)
	}
	if len(heat.Cells) == 0 {
		t.Fatal("expected at least one heatmap cell")
	}
}

func TestParseWindowFallbacks(t *testing.T) {
	now := time.Now()
	cases := []struct {
		raw     string
		wantMin time.Duration
		wantMax time.Duration
	}{
		{"", 23 * time.Hour, 25 * time.Hour},
		{"7d", 7*24*time.Hour - time.Hour, 7*24*time.Hour + time.Hour},
		{"30d", 30*24*time.Hour - time.Hour, 30*24*time.Hour + time.Hour},
	}
	for _, tc := range cases {
		got := parseWindow(tc.raw, 24*time.Hour, "hour")
		delta := now.Sub(got)
		if delta < tc.wantMin || delta > tc.wantMax {
			t.Errorf("parseWindow(%q): delta=%s, want between %s and %s", tc.raw, delta, tc.wantMin, tc.wantMax)
		}
	}
}
