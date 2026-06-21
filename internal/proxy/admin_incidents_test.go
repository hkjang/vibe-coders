package proxy

import (
	"sort"
	"testing"
)

func TestSeverityRankOrdering(t *testing.T) {
	if !(severityRank("critical") > severityRank("warning") && severityRank("warning") > severityRank("info") && severityRank("info") > severityRank("")) {
		t.Fatal("severity ranking must be critical > warning > info > unknown")
	}
	// Sorting incidents by severity puts critical first.
	in := []incident{{Severity: "info"}, {Severity: "critical"}, {Severity: "warning"}}
	sort.SliceStable(in, func(i, j int) bool { return severityRank(in[i].Severity) > severityRank(in[j].Severity) })
	if in[0].Severity != "critical" || in[1].Severity != "warning" || in[2].Severity != "info" {
		t.Errorf("sort order wrong: %+v", in)
	}
}
