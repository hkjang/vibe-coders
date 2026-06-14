package proxy

import "testing"

func TestGoldenSQLMatch(t *testing.T) {
	expected := "SELECT dept, count(*) FROM itsm_requests GROUP BY dept"
	// Same tokens, different whitespace/case → match.
	if !goldenSQLMatch(expected, "select  dept , COUNT(*)\nfrom itsm_requests\ngroup by dept") {
		t.Error("expected a token-equivalent query to match")
	}
	// Different table → should not match.
	if goldenSQLMatch(expected, "SELECT dept, count(*) FROM other_table GROUP BY dept") {
		t.Error("a query against a different table should not match")
	}
	// Empty expected → no match.
	if goldenSQLMatch("", "SELECT 1") {
		t.Error("empty expected should not match")
	}
}
