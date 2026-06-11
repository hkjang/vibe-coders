package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedCostReq(t *testing.T, db *store.SQLStore, id string, cost float64, when time.Time) {
	t.Helper()
	rec := store.LogRecord{
		Request: store.RequestLog{
			ID: id, TraceID: id, Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
			StatusCode: 200, LatencyMS: 100, FirstChunkMS: 50, CreatedAt: when,
		},
		Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when},
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

func TestModelAnomaliesDetectsCostSpike(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// baseline: 40 requests over the last 2-5 days, cost ~100 (tiny variance)
	for i := 0; i < 40; i++ {
		when := now.Add(-time.Duration(48+i) * time.Hour) // 2 days .. ~3.6 days ago
		cost := 100.0
		if i%2 == 0 {
			cost = 102
		}
		seedCostReq(t, db, "base-"+itoaT(i), cost, when)
	}
	// recent: 10 requests in the last 30 min, cost ~500 (5x spike)
	for i := 0; i < 10; i++ {
		seedCostReq(t, db, "rec-"+itoaT(i), 500, now.Add(-time.Duration(i)*time.Minute))
	}

	findings, err := db.ModelAnomalies(ctx, 7*24*time.Hour, time.Hour, 3)
	if err != nil {
		t.Fatal(err)
	}
	var cost *store.AnomalyFinding
	for i := range findings {
		if findings[i].Model == "gpt-4.1" && findings[i].Metric == "cost_per_request" {
			cost = &findings[i]
		}
	}
	if cost == nil {
		t.Fatalf("expected a cost_per_request anomaly for gpt-4.1, got %#v", findings)
	}
	if cost.Direction != "up" {
		t.Errorf("expected direction up, got %s", cost.Direction)
	}
	if cost.ZScore < 3 {
		t.Errorf("expected z>=3 for a 5x spike, got %.2f", cost.ZScore)
	}
	if cost.RecentMean < 400 || cost.BaselineMean > 200 {
		t.Errorf("unexpected means: recent=%.1f baseline=%.1f", cost.RecentMean, cost.BaselineMean)
	}

	// MaxAnomalyZ should be positive and >= the cost z
	if maxZ, err := db.MaxAnomalyZ(ctx, 7*24*time.Hour, time.Hour); err != nil || maxZ < 3 {
		t.Fatalf("expected MaxAnomalyZ >= 3, got %.2f (err=%v)", maxZ, err)
	}
}

func TestModelAnomaliesQuietWhenStable(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	for i := 0; i < 40; i++ {
		seedCostReq(t, db, "b-"+itoaT(i), 100, now.Add(-time.Duration(48+i)*time.Hour))
	}
	for i := 0; i < 10; i++ {
		seedCostReq(t, db, "r-"+itoaT(i), 100, now.Add(-time.Duration(i)*time.Minute))
	}
	findings, err := db.ModelAnomalies(ctx, 7*24*time.Hour, time.Hour, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("expected no anomalies for stable traffic, got %#v", findings)
	}
}

func TestAnomaliesEndpoint(t *testing.T) {
	db := openTestStore(t)
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

	now := time.Now().UTC()
	for i := 0; i < 40; i++ {
		seedCostReq(t, db, "eb-"+itoaT(i), 100, now.Add(-time.Duration(48+i)*time.Hour))
	}
	for i := 0; i < 10; i++ {
		seedCostReq(t, db, "er-"+itoaT(i), 800, now.Add(-time.Duration(i)*time.Minute))
	}

	resp, err := http.Get(proxy.URL + "/admin/anomalies?recent=1h&z=3")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Anomalies      []store.AnomalyFinding     `json:"anomalies"`
		CostAnomalies  []store.CostAnomalyFinding `json:"cost_anomalies"`
		InsertedEvents []store.AnomalyEvent       `json:"inserted_events"`
		Events         []store.AnomalyEvent       `json:"events"`
		ZThreshold     float64                    `json:"z_threshold"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Anomalies) == 0 {
		t.Fatal("expected anomalies from cost spike via endpoint")
	}
	if len(payload.CostAnomalies) == 0 {
		t.Fatal("expected scope cost anomalies via endpoint")
	}
	if len(payload.InsertedEvents) == 0 || len(payload.Events) == 0 {
		t.Fatalf("expected anomaly events to be recorded, inserted=%v events=%v", payload.InsertedEvents, payload.Events)
	}
}

func TestAnomalyAlertWebhook(t *testing.T) {
	var calls atomic.Int32
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte("cost")) && !bytes.Contains(body, []byte("비용")) {
			t.Errorf("webhook payload missing anomaly text: %s", body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer webhook.Close()

	db := openTestStore(t)
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

	cfgResp := postJSON(t, proxy.URL+"/admin/anomalies", "", map[string]any{
		"enabled":     true,
		"webhook_url": webhook.URL,
	})
	if cfgResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(cfgResp.Body)
		t.Fatalf("config status %d: %s", cfgResp.StatusCode, body)
	}
	cfgResp.Body.Close()

	now := time.Now().UTC()
	for i := 0; i < 40; i++ {
		seedCostReq(t, db, "wb-"+itoaT(i), 100, now.Add(-time.Duration(48+i)*time.Hour))
	}
	for i := 0; i < 10; i++ {
		seedCostReq(t, db, "wr-"+itoaT(i), 900, now.Add(-time.Duration(i)*time.Minute))
	}
	resp, err := http.Get(proxy.URL + "/admin/anomalies?recent=1h&z=3")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		InsertedEvents []store.AnomalyEvent `json:"inserted_events"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.InsertedEvents) == 0 {
		t.Fatalf("expected inserted anomaly events")
	}
	if calls.Load() == 0 {
		t.Fatalf("expected anomaly webhook to be called")
	}
	notified := false
	for _, event := range payload.InsertedEvents {
		if event.Status == "notified" && event.Channel == "admin_ui,webhook" {
			notified = true
		}
	}
	if !notified {
		t.Fatalf("expected at least one notified webhook event, got %+v", payload.InsertedEvents)
	}
}

func itoaT(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
