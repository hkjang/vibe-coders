package store

import (
	"context"
	"testing"
	"time"
)

func TestSavingsAggregates(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project, requested, served, routeReason string, prompt, completion int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: served, RequestedModel: requested, RouteReason: routeReason, Provider: "openai",
				StatusCode: 200, Project: project, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, PromptTokens: prompt, CompletionTokens: completion,
				TotalTokens: prompt + completion, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Two downshifted requests (asked gpt-4.1, served gpt-4.1-mini) in project "alpha".
	rec("d1", "alpha", "gpt-4.1", "gpt-4.1-mini", "model_pattern", 1000, 500, 2)
	rec("d2", "alpha", "gpt-4.1", "gpt-4.1-mini", "model_pattern", 1000, 500, 2)
	// One non-downshift request (served == requested) — excluded from downshift.
	rec("n1", "alpha", "gpt-4.1-mini", "gpt-4.1-mini", "default", 800, 400, 2)
	// One cache hit and one normal request for cache accounting.
	rec("c1", "alpha", "", "gpt-4.1-mini", "cache", 0, 0, 0)

	// Downshift aggregation: one (alpha, gpt-4.1) group with 2 requests, summed tokens.
	ds, err := db.RoutingDownshiftUsage(ctx, "project", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 1 {
		t.Fatalf("expected 1 downshift group, got %d (%+v)", len(ds), ds)
	}
	d := ds[0]
	if d.Scope != "alpha" || d.RequestedModel != "gpt-4.1" {
		t.Errorf("downshift key = %q/%q, want alpha/gpt-4.1", d.Scope, d.RequestedModel)
	}
	if d.Requests != 2 || d.PromptTokens != 2000 || d.CompletionTokens != 1000 {
		t.Errorf("downshift sums = %d reqs / %d prompt / %d completion, want 2/2000/1000", d.Requests, d.PromptTokens, d.CompletionTokens)
	}
	if d.ActualCostKRW < 3.99 || d.ActualCostKRW > 4.01 {
		t.Errorf("downshift actual cost = %f, want ~4", d.ActualCostKRW)
	}

	// Cache aggregation: 1 cache hit, 3 non-cache requests, non-cache cost = 6.
	cu, err := db.CacheUsage(ctx, "project", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var alpha CacheUsageRow
	for _, c := range cu {
		if c.Scope == "alpha" {
			alpha = c
		}
	}
	if alpha.CacheHits != 1 || alpha.NonCacheRequests != 3 {
		t.Errorf("cache usage = %d hits / %d non-cache, want 1/3", alpha.CacheHits, alpha.NonCacheRequests)
	}
	if alpha.NonCacheCostKRW < 5.99 || alpha.NonCacheCostKRW > 6.01 {
		t.Errorf("non-cache cost = %f, want ~6", alpha.NonCacheCostKRW)
	}

	// Unsupported dimension errors.
	if _, err := db.RoutingDownshiftUsage(ctx, "bogus", now); err == nil {
		t.Error("unsupported dimension should error")
	}
}
