package proxy

import (
	"testing"

	"vibe-coders/internal/config"
)

func newMetricTestServer() *Server {
	return &Server{cfg: config.Config{ClickHouse: config.ClickHouseConfig{
		URL: "http://ch", RequestFactTable: "ai_request_fact",
	}}}
}

func TestValidateMetricQuery(t *testing.T) {
	s := newMetricTestServer()

	// Valid aggregate over a known fact table.
	v := s.validateMetricQuery("SELECT team, sum(cost_krw) FROM ai_request_fact GROUP BY team")
	if !v["ok"].(bool) {
		t.Fatalf("valid query should pass: %+v", v)
	}

	// Write statement rejected.
	if s.validateMetricQuery("DELETE FROM ai_request_fact")["ok"].(bool) {
		t.Error("DELETE must fail")
	}
	// Non-SELECT rejected.
	if s.validateMetricQuery("EXPLAIN SELECT 1")["ok"].(bool) {
		t.Error("non-SELECT must fail")
	}
	// Sensitive column rejected.
	if s.validateMetricQuery("SELECT prompt_text FROM ai_request_fact")["ok"].(bool) {
		t.Error("sensitive column must fail")
	}
	// Unknown table → warning (still ok=true).
	v2 := s.validateMetricQuery("SELECT count(*) FROM some_random_table")
	if !v2["ok"].(bool) {
		t.Errorf("unknown table is a warning, not an error: %+v", v2)
	}
	if len(v2["warnings"].([]string)) == 0 {
		t.Error("unknown non-fact table should warn")
	}
}
