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

func TestScatterPointsCarryCategoryFields(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	mk := func(id string, latency int64, status int, provider string, failover bool, tokens int, cost float64) {
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
				Provider: provider, StatusCode: status, LatencyMS: latency, FirstChunkMS: latency / 2,
				Failover: failover, CreatedAt: now,
			},
		}
		if tokens > 0 {
			rec.Usage = &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: now}
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mk("ok1", 120, 200, "openai", false, 100, 5)
	mk("slow", 9000, 200, "openai", false, 9000, 800) // outlier, high tokens
	mk("err1", 300, 500, "openai", false, 0, 0)
	mk("cache1", 1, 200, "cache", false, 50, 0)
	mk("fb1", 400, 200, "backup", true, 200, 10)
	if err := db.InsertPolicyDecisionEvent(ctx, store.PolicyDecisionEvent{
		ID:        "pde_ok1",
		RequestID: "ok1",
		Decision:  "mask",
		Reason:    "masked by policy",
		CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertApproval(ctx, store.Approval{
		ID:        "appr_ok1",
		RequestID: "ok1",
		Status:    "pending",
		Reason:    "approval pending",
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertSecretEvent(ctx, store.SecretEvent{
		ID:         "sec_ok1",
		RequestID:  "ok1",
		SecretType: "api_key",
		Action:     "mask",
		CreatedAt:  now,
	}); err != nil {
		t.Fatal(err)
	}

	points, truncated, err := db.ScatterPoints(ctx, store.ScatterFilter{Since: now.Add(-time.Hour), Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("did not expect truncation")
	}
	if len(points) != 5 {
		t.Fatalf("expected 5 points, got %d", len(points))
	}
	by := map[string]store.ScatterPoint{}
	for _, p := range points {
		by[p.RequestID] = p
	}
	if by["slow"].LatencyMS != 9000 {
		t.Errorf("outlier latency not preserved: %d", by["slow"].LatencyMS)
	}
	if by["err1"].StatusCode != 500 {
		t.Errorf("error status not preserved")
	}
	if by["cache1"].Provider != "cache" {
		t.Errorf("cache provider not preserved")
	}
	if !by["fb1"].Failover {
		t.Errorf("failover flag not preserved")
	}
	if by["slow"].TotalTokens != 9000 {
		t.Errorf("tokens not preserved: %d", by["slow"].TotalTokens)
	}
	if by["ok1"].PolicyDecisionCount != 1 || by["ok1"].PolicyDecision != "mask" {
		t.Errorf("policy decision summary not preserved: %+v", by["ok1"])
	}
	if by["ok1"].ApprovalCount != 1 || by["ok1"].ApprovalStatus != "pending" {
		t.Errorf("approval summary not preserved: %+v", by["ok1"])
	}
	if by["ok1"].SecretEventCount != 1 || by["ok1"].SecretAction != "mask" {
		t.Errorf("secret summary not preserved: %+v", by["ok1"])
	}
}

func TestScatterTruncationFlag(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	for i := 0; i < 12; i++ {
		id := "p" + itoaT(i)
		_ = db.InsertLogRecord(ctx, store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", StatusCode: 200, LatencyMS: int64(100 + i), CreatedAt: now.Add(time.Duration(i) * time.Second)},
		})
	}
	points, truncated, err := db.ScatterPoints(ctx, store.ScatterFilter{Since: now.Add(-time.Hour), Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("expected truncation flag with limit 5 over 12 rows")
	}
	if len(points) != 5 {
		t.Fatalf("expected exactly 5 points after cap, got %d", len(points))
	}
}

func TestScatterEndpoint(t *testing.T) {
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

	r := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	r.Body.Close()
	waitFor(t, time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 1
	})

	resp, err := http.Get(proxy.URL + "/admin/scatter?window=1h")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Points    []store.ScatterPoint `json:"points"`
		Truncated bool                 `json:"truncated"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Points) != 1 {
		t.Fatalf("expected 1 scatter point, got %d", len(payload.Points))
	}
	if payload.Points[0].LatencyMS < 0 {
		t.Fatal("latency should be set")
	}
}
