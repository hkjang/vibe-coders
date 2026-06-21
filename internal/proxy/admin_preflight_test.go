package proxy

import "testing"

func TestRankPF(t *testing.T) {
	if !(rankPF("fail") > rankPF("warn") && rankPF("warn") > rankPF("ok") && rankPF("ok") > rankPF("")) {
		t.Fatal("preflight rank must be fail > warn > ok > unknown")
	}
}

func TestCriticalTablesPresent(t *testing.T) {
	// The preflight must check a non-trivial, deduplicated set of critical tables.
	if len(criticalTables) < 5 {
		t.Fatalf("expected several critical tables, got %d", len(criticalTables))
	}
	seen := map[string]bool{}
	for _, tb := range criticalTables {
		if tb == "" || seen[tb] {
			t.Errorf("invalid/duplicate critical table: %q", tb)
		}
		seen[tb] = true
	}
}
