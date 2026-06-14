package proxy

import "testing"

func TestParseExplainCost(t *testing.T) {
	// PostgreSQL EXPLAIN (FORMAT JSON) output shape.
	raw := []byte(`[{"Plan":{"Node Type":"Seq Scan","Total Cost":12345.67,"Plan Rows":100}}]`)
	cost, err := parseExplainCost(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cost != 12345.67 {
		t.Errorf("cost = %v, want 12345.67", cost)
	}

	if _, err := parseExplainCost([]byte(`[]`)); err == nil {
		t.Error("expected error for empty EXPLAIN output")
	}
	if _, err := parseExplainCost([]byte(`not json`)); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestScoreExplainPlan(t *testing.T) {
	// Nested plan tree with a large Seq Scan + Nested Loop.
	raw := []byte(`[{"Plan":{"Node Type":"Nested Loop","Total Cost":250000,"Plan Rows":500000,"Plans":[{"Node Type":"Seq Scan","Total Cost":120000,"Plan Rows":500000},{"Node Type":"Index Scan","Total Cost":50,"Plan Rows":1}]}}]`)
	plan, err := parseExplainPlan(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.HasSeqScan || !plan.HasNestedLoop {
		t.Errorf("expected seq scan + nested loop flags: %+v", plan)
	}
	if plan.TotalCost != 250000 {
		t.Errorf("total cost = %v, want 250000", plan.TotalCost)
	}
	// Cost (250000) over limit (100000) → +50, large seq scan → +25, large nested loop → +20.
	risk := scoreExplainPlan(plan, 100000)
	if risk.Score < 50 {
		t.Errorf("expected high risk score, got %d (%v)", risk.Score, risk.Reasons)
	}

	// A cheap indexed plan → low risk.
	cheap, _ := parseExplainPlan([]byte(`[{"Plan":{"Node Type":"Index Scan","Total Cost":12.5,"Plan Rows":3}}]`))
	if r := scoreExplainPlan(cheap, 100000); r.Score != 0 {
		t.Errorf("cheap plan should score 0, got %d", r.Score)
	}
}
