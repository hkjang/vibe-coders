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

func TestAdminOverviewOneHourTimeseriesContract(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	now := time.Now().UTC()
	for i, offset := range []time.Duration{-2 * time.Hour, -30 * time.Minute, -5 * time.Minute} {
		id := "overview-hour-" + string(rune('a'+i))
		when := now.Add(offset)
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", Model: "synthetic", StatusCode: 200, CreatedAt: when},
			Usage:   &store.TokenUsage{ID: id + "-usage", RequestID: id, TotalTokens: 15, EstimatedCost: 0.0004, Currency: "KRW", Source: "fixture", CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig("http://127.0.0.1:9", "")
	cfg.Auth.AdminToken, cfg.Auth.AdminReadonlyToken = "synthetic-writer", "synthetic-reader"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Routes()
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, "/admin/timeseries?window=1h&bucket=hour", nil))
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status: %d", denied.Code)
	}
	request := httptest.NewRequest(http.MethodGet, "/admin/timeseries?window=1h&bucket=hour", nil)
	request.Header.Set("Authorization", "Bearer synthetic-reader")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("read-only status: %d", response.Code)
	}
	var result struct {
		Bucket string                  `json:"bucket"`
		Since  string                  `json:"since"`
		Points []store.TimeseriesPoint `json:"points"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	since, err := time.Parse(time.RFC3339, result.Since)
	if err != nil || since.Before(now.Add(-time.Hour-time.Second)) || since.After(time.Now().Add(-time.Hour+time.Second)) {
		t.Fatal("one-hour response did not report its actual lower bound")
	}
	if result.Bucket != "hour" || len(result.Points) == 0 || len(result.Points) > 2 {
		t.Fatal("one-hour data must use the existing hour buckets")
	}
	expected := map[string]int64{}
	for _, offset := range []time.Duration{-30 * time.Minute, -5 * time.Minute} {
		expected[now.Add(offset).In(time.FixedZone("KST", 9*3600)).Format("2006-01-02T15")]++
	}
	var requests, tokens int64
	var cost float64
	for _, point := range result.Points {
		if point.Bucket != "hour" || expected[point.Date] != point.Requests {
			t.Fatal("unexpected Seoul bucket or request count")
		}
		requests += point.Requests
		tokens += point.Tokens
		cost += point.CostKRW
	}
	if requests != 2 || tokens != 30 || cost != 0.0008 {
		t.Fatalf("unexpected one-hour totals: %d requests, %d tokens, %g cost", requests, tokens, cost)
	}
}
