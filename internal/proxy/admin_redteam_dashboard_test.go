package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestRedTeamAggregate(t *testing.T) {
	rows := []store.RedTeamDashboardRow{
		{TargetID: "t1", TargetType: "provider", TargetRef: "provider:openai", OwnerTeam: "platform", PackID: "p1", PackCategory: "data_leakage", Decision: "critical", Severity: "critical", RiskScore: 70},
		{TargetID: "t1", TargetType: "provider", TargetRef: "provider:openai", OwnerTeam: "platform", PackID: "p1", PackCategory: "data_leakage", Decision: "pass", Severity: "low", RiskScore: 70},
		{TargetID: "t2", TargetType: "mcp_tool", TargetRef: "tool:gh__delete", OwnerTeam: "dev", PackID: "p2", PackCategory: "tool_misuse", Decision: "fail", Severity: "high", RiskScore: 40},
		{TargetID: "t3", TargetType: "provider", TargetRef: "provider:ollama", OwnerTeam: "platform", PackID: "p1", PackCategory: "data_leakage", Decision: "pass", Severity: "low", RiskScore: 0},
	}

	agg := redTeamAggregate(rows)

	if agg.TotalResults != 4 {
		t.Fatalf("TotalResults = %d, want 4", agg.TotalResults)
	}
	if agg.ByDecision["critical"] != 1 || agg.ByDecision["fail"] != 1 || agg.ByDecision["pass"] != 2 {
		t.Fatalf("ByDecision unexpected: %+v", agg.ByDecision)
	}
	if agg.MaxRisk != 70 {
		t.Fatalf("MaxRisk = %d, want 70", agg.MaxRisk)
	}

	// Matrix: provider/data_leakage should have pass=2, critical=1, total=3.
	var found bool
	for _, c := range agg.Matrix {
		if c.TargetType == "provider" && c.PackCategory == "data_leakage" {
			found = true
			if c.Pass != 2 || c.Critical != 1 || c.Total != 3 {
				t.Fatalf("provider/data_leakage cell = %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("expected provider/data_leakage matrix cell")
	}

	// Top failing: t1 (critical) must rank above t2 (fail); t3 (all pass) excluded.
	if len(agg.TopFailingTargets) != 2 {
		t.Fatalf("TopFailingTargets len = %d, want 2 (t3 all-pass excluded)", len(agg.TopFailingTargets))
	}
	if agg.TopFailingTargets[0]["target_ref"].(string) != "provider:openai" {
		t.Fatalf("top failing target = %v, want provider:openai (critical outranks fail)", agg.TopFailingTargets[0]["target_ref"])
	}
}

func TestRedTeamAggregateEmpty(t *testing.T) {
	agg := redTeamAggregate(nil)
	if agg.TotalResults != 0 || len(agg.Matrix) != 0 || len(agg.TopFailingTargets) != 0 {
		t.Fatalf("empty aggregate not clean: %+v", agg)
	}
}

func TestRedTeamBaselineDrift(t *testing.T) {
	baselines := []store.RedTeamBaseline{
		{TargetID: "t1", PackID: "p1", BaselineScore: 20, DriftThreshold: 10}, // current 70 → delta 50 > 10 → drift
		{TargetID: "t2", PackID: "p2", BaselineScore: 40, DriftThreshold: 10}, // current 45 → delta 5 <= 10 → no drift
		{TargetID: "t9", PackID: "p9", BaselineScore: 10, DriftThreshold: 5},  // no current → skip
	}
	latest := map[string]int{"t1": 70, "t2": 45}

	drift := redTeamBaselineDrift(baselines, latest)
	if len(drift) != 1 {
		t.Fatalf("drift len = %d, want 1", len(drift))
	}
	if drift[0]["target_id"].(string) != "t1" || drift[0]["delta"].(int) != 50 {
		t.Fatalf("unexpected drift entry: %+v", drift[0])
	}
}
