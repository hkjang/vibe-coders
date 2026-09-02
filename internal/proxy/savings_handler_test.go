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

// TestSavingsHandler exercises the /admin/savings HTTP handler end-to-end: it combines the
// routing-downshift baseline pricing and the cache-hit savings estimate into one report.
// The store-level aggregation is covered by store.TestSavingsAggregates; this test verifies
// the handler's pricing math (baseline at the requested model minus actual cost) and shape.
func TestSavingsHandler(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "sav.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project, requested, served, routeReason string, prompt, completion int, cost float64) {
		if err := db.InsertLogRecord(ctx, store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: served, RequestedModel: requested, RouteReason: routeReason, Provider: "openai",
				StatusCode: 200, Project: project, CreatedAt: now},
			Usage: &store.TokenUsage{ID: id + "_u", RequestID: id, PromptTokens: prompt, CompletionTokens: completion,
				TotalTokens: prompt + completion, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Two downshifts (asked premium, served cheaper) + a cache hit + its non-cache peers.
	rec("d1", "alpha", "premium-x", "cheap-y", "model_pattern", 1000, 500, 2)
	rec("d2", "alpha", "premium-x", "cheap-y", "model_pattern", 1000, 500, 2)
	rec("n1", "alpha", "cheap-y", "cheap-y", "default", 800, 400, 2)
	rec("c1", "alpha", "", "cheap-y", "cache", 0, 0, 0)

	// Price the requested (premium) model high so the downshift baseline far exceeds the
	// actual served cost — guaranteeing positive savings independent of the seeded catalog.
	if err := db.InsertPricingVersion(ctx, &store.ModelPricingVersion{
		ID: newID("price"), Model: "premium-x", InputKRWPer1M: 100000, OutputKRWPer1M: 100000, Source: "manual",
	}); err != nil {
		t.Fatal(err)
	}
	server.invalidatePricingCache()

	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/admin/savings?dimension=project&window=7d")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("savings = %d", resp.StatusCode)
	}
	var out struct {
		Dimension                string  `json:"dimension"`
		TotalDownshiftSavingsKRW float64 `json:"total_downshift_savings_krw"`
		TotalCacheSavingsKRW     float64 `json:"total_cache_savings_krw"`
		TotalSavingsKRW          float64 `json:"total_savings_krw"`
		Scopes                   []struct {
			Scope               string  `json:"scope"`
			DownshiftRequests   int64   `json:"downshift_requests"`
			DownshiftSavingsKRW float64 `json:"downshift_savings_krw"`
			CacheHits           int64   `json:"cache_hits"`
			CacheSavingsKRW     float64 `json:"cache_savings_krw"`
			TotalSavingsKRW     float64 `json:"total_savings_krw"`
		} `json:"scopes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Dimension != "project" || len(out.Scopes) != 1 {
		t.Fatalf("expected one project scope, got %+v", out)
	}
	sc := out.Scopes[0]
	if sc.Scope != "alpha" {
		t.Fatalf("scope = %q, want alpha", sc.Scope)
	}
	if sc.DownshiftRequests != 2 {
		t.Errorf("downshift_requests = %d, want 2", sc.DownshiftRequests)
	}
	if sc.CacheHits != 1 {
		t.Errorf("cache_hits = %d, want 1", sc.CacheHits)
	}
	// Baseline at premium-x (2000 prompt + 1000 completion tokens @ 100000 KRW/1M) ≈ 300 KRW
	// minus ~4 KRW actual → downshift savings clearly positive.
	if sc.DownshiftSavingsKRW <= 0 {
		t.Errorf("downshift_savings_krw = %f, want > 0", sc.DownshiftSavingsKRW)
	}
	// Cache savings: 1 hit × (non-cache cost 6 / 3 non-cache requests) = 2.
	if sc.CacheSavingsKRW < 1.99 || sc.CacheSavingsKRW > 2.01 {
		t.Errorf("cache_savings_krw = %f, want ~2", sc.CacheSavingsKRW)
	}
	if out.TotalSavingsKRW <= out.TotalCacheSavingsKRW {
		t.Errorf("total savings %f should exceed cache-only %f (downshift adds value)", out.TotalSavingsKRW, out.TotalCacheSavingsKRW)
	}
}
