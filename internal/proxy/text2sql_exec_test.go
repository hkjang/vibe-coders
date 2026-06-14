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
