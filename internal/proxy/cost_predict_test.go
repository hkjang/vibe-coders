package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func pricingFixture() map[string]config.ModelPrice {
	return map[string]config.ModelPrice{
		"premium": {InputKRWPer1M: 10000, OutputKRWPer1M: 30000},
		"cheap":   {InputKRWPer1M: 200, OutputKRWPer1M: 600},
	}
}

func TestPredictCostBasis(t *testing.T) {
	pricing := pricingFixture()
	snap := &costSnapshot{byModel: map[string]store.ModelStat{
		"premium": {Model: "premium", AvgOutputTokens: 1000, AvgLatencyMS: 4200, Samples: 50},
	}}

	// history basis: uses avg output (1000) + avg latency
	e := predictCost("premium", 2000, 0, snap, pricing)
	if e.Basis != "history" || e.OutputTokens != 1000 || e.LatencyMS != 4200 {
		t.Fatalf("history estimate wrong: %+v", e)
	}
	// cost = 2000*10000/1e6 + 1000*30000/1e6 = 20 + 30 = 50 KRW
	if e.CostKRW < 49.9 || e.CostKRW > 50.1 {
		t.Fatalf("cost = %.2f, want ~50", e.CostKRW)
	}
	if !e.Priced {
		t.Fatal("premium should be priced")
	}

	// no history → max_tokens basis
	e2 := predictCost("cheap", 1000, 4000, snap, pricing)
	if e2.Basis != "max_tokens" || e2.OutputTokens != 4000 {
		t.Fatalf("max_tokens estimate wrong: %+v", e2)
	}
	// no history, no max_tokens → default
	e3 := predictCost("cheap", 1000, 0, snap, pricing)
	if e3.Basis != "default" || e3.OutputTokens != defaultExpectedOutputTokens {
		t.Fatalf("default estimate wrong: %+v", e3)
	}
	// unpriced model → priced=false, cost 0
	e4 := predictCost("mystery", 1000, 100, snap, pricing)
	if e4.Priced || e4.CostKRW != 0 {
		t.Fatalf("unpriced model should have priced=false cost=0: %+v", e4)
	}
}

func TestParseMaxTokens(t *testing.T) {
	if got := parseMaxTokens([]byte(`{"model":"m","max_tokens":4096}`)); got != 4096 {
		t.Fatalf("max_tokens=%d want 4096", got)
	}
	if got := parseMaxTokens([]byte(`{"model":"m","max_completion_tokens":2048}`)); got != 2048 {
		t.Fatalf("max_completion_tokens=%d want 2048", got)
	}
	if got := parseMaxTokens([]byte(`{"model":"m"}`)); got != 0 {
		t.Fatalf("absent max_tokens should be 0, got %d", got)
	}
}

func buildCostServer(t *testing.T) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://example.invalid", "secret")
	cfg.Pricing = pricingFixture()
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

func TestCostGuardEndpointAndConfig(t *testing.T) {
	s, db := buildCostServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	ctx := context.Background()

	// set guard: enabled, threshold 40 KRW
	resp := postJSON(t, proxy.URL+"/admin/cost", "", map[string]any{"enabled": true, "threshold_krw": 40})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set cost guard failed: %d", resp.StatusCode)
	}
	resp.Body.Close()

	snap := s.costSnapshotCached(ctx)
	if !snap.guardEnabled || snap.guardThreshold != 40 {
		t.Fatalf("guard config not applied: %+v", snap)
	}
	_ = db

	// dry-run predict: premium 2000 in, history-less → default 600 out
	// cost = 2000*10000/1e6 + 600*30000/1e6 = 20 + 18 = 38 KRW (< 40, under threshold)
	pr := postJSON(t, proxy.URL+"/admin/cost/predict", "", map[string]any{"model": "premium", "input_tokens": 2000})
	if pr.StatusCode != http.StatusOK {
		t.Fatalf("predict failed: %d", pr.StatusCode)
	}
	var est CostEstimate
	_ = json.NewDecoder(pr.Body).Decode(&est)
	pr.Body.Close()
	if est.OutputTokens != defaultExpectedOutputTokens || est.CostKRW < 37.9 || est.CostKRW > 38.1 {
		t.Fatalf("predict estimate wrong: %+v", est)
	}
}

func TestCostGuardBlocksAndApproves(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig(upstream.URL, "secret")
	cfg.Pricing = pricingFixture()
	s, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	// enable guard with a tiny threshold so any priced call exceeds it
	if err := db.SetFlag(context.Background(), store.RuntimeFlag{Key: "cost_guard_enabled", Value: "true"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetFlag(context.Background(), store.RuntimeFlag{Key: "cost_guard_threshold_krw", Value: "1"}); err != nil {
		t.Fatal(err)
	}

	body := chatBody("premium", false)

	// blocked (estimated cost > 1 KRW, no approval)
	blocked := postJSON(t, proxy.URL+"/v1/chat/completions", "", body)
	defer blocked.Body.Close()
	if blocked.StatusCode != http.StatusPaymentRequired {
		bb, _ := io.ReadAll(blocked.Body)
		t.Fatalf("expected 402, got %d: %s", blocked.StatusCode, bb)
	}
	if blocked.Header.Get("X-Cost-Guard") != "blocked" || blocked.Header.Get("X-Estimated-Cost-KRW") == "" {
		t.Fatalf("missing cost guard headers: %v", blocked.Header)
	}

	// approved via header → passes through to upstream
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", jsonReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cost-Approve", "1")
	approved, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer approved.Body.Close()
	if approved.StatusCode != http.StatusOK {
		t.Fatalf("approved request should pass, got %d", approved.StatusCode)
	}
}
