package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestPersonalizationCoachingItemsForProfile(t *testing.T) {
	items := personalizationCoachingItemsForProfile(store.PersonalProfile{
		UserID:               "u1",
		Team:                 "platform",
		Role:                 "developer",
		Requests:             20,
		TotalCostKRW:         200,
		AvgCostPerRequest:    10,
		ErrorRate:            0.3,
		CacheRate:            0.01,
		Text2SQLUsageRate:    0.4,
		MCPUsageRate:         0.35,
		RiskScore:            72,
		DistinctFingerprints: 18,
		TopMCPTools:          []store.ProfileCount{{Key: "jira/create_issue", Requests: 5}},
	})
	byCategory := map[string]personalizationCoachingItem{}
	for _, item := range items {
		byCategory[item.Category] = item
	}
	for _, category := range []string{"security", "quality", "reuse", "cost", "text2sql", "mcp"} {
		if _, ok := byCategory[category]; !ok {
			t.Fatalf("missing coaching category %q in %+v", category, items)
		}
	}
	if byCategory["security"].Severity != "high" {
		t.Fatalf("security severity = %q", byCategory["security"].Severity)
	}
	if byCategory["reuse"].Metrics["distinct_prompt_fingerprints"] == nil {
		t.Fatalf("reuse metrics should include distinct prompt fingerprints: %+v", byCategory["reuse"])
	}
}

func TestPersonalizationAffinityScores(t *testing.T) {
	goodModel := modelAffinityScore(20, 0.95, 1)
	weakModel := modelAffinityScore(2, 0.5, 20)
	if goodModel <= weakModel {
		t.Fatalf("expected strong model affinity score > weak score, got %f <= %f", goodModel, weakModel)
	}
	goodMCP := mcpAffinityScore(10, 1, 100)
	slowFailingMCP := mcpAffinityScore(10, 0.4, 5000)
	if goodMCP <= slowFailingMCP {
		t.Fatalf("expected strong MCP affinity score > weak score, got %f <= %f", goodMCP, slowFailingMCP)
	}
}

func TestPersonalizationText2SQLHintItemsForUser(t *testing.T) {
	items := personalizationText2SQLHintItemsForUser("u1", store.PersonalProfile{
		Team: "analytics",
		Role: "developer",
	}, []store.UserText2SQLReportCandidate{{
		Fingerprint: "t2sql_abc123", SchemaName: "sales", Count: 4,
		SuccessRate: 1, AvgCostKRW: 2.5, RecommendedProduct: "dashboard", LastSeen: "2026-06-19T00:00:00Z",
	}})
	if len(items) != 1 {
		t.Fatalf("expected 1 hint item, got %+v", items)
	}
	item := items[0]
	if item.UserID != "u1" || item.Team != "analytics" || item.HintType != "saved_dashboard" {
		t.Fatalf("unexpected hint item: %+v", item)
	}
	if item.EstimatedSavingsKRW != 7.5 {
		t.Fatalf("estimated savings = %f, want 7.5", item.EstimatedSavingsKRW)
	}
	if item.Fingerprint != "t2sql_abc123" {
		t.Fatalf("fingerprint should be preserved, got %+v", item)
	}
}
