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
