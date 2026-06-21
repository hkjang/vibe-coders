package proxy

import "testing"

func TestScorecardOverallSkipsMissingDims(t *testing.T) {
	// -1 dimensions are excluded; overall averages only the present ones.
	ts := teamScore{CostEfficiency: 80, SuccessRate: 90, CacheRate: -1, SkillReuse: -1,
		MCPSuccess: -1, Text2SQLSuccess: -1, PolicyComply: 100, Satisfaction: -1}
	overall, grade := scorecardOverall(ts)
	if overall != 90 { // (80+90+100)/3
		t.Fatalf("overall = %v, want 90", overall)
	}
	if grade != "A" {
		t.Fatalf("grade = %q, want A", grade)
	}
	// No dimensions → N/A.
	if _, g := scorecardOverall(teamScore{CostEfficiency: -1, SuccessRate: -1, CacheRate: -1, SkillReuse: -1, MCPSuccess: -1, Text2SQLSuccess: -1, PolicyComply: -1, Satisfaction: -1}); g != "N/A" {
		t.Fatalf("empty grade = %q, want N/A", g)
	}
}

func TestScorecardGradeBoundaries(t *testing.T) {
	mk := func(v float64) string { _, g := scorecardOverall(teamScore{SuccessRate: v, CostEfficiency: -1, CacheRate: -1, SkillReuse: -1, MCPSuccess: -1, Text2SQLSuccess: -1, PolicyComply: -1, Satisfaction: -1}); return g }
	cases := map[float64]string{85: "A", 84.9: "B", 70: "B", 69.9: "C", 55: "C", 54.9: "D"}
	for v, want := range cases {
		if got := mk(v); got != want {
			t.Errorf("score %.1f → grade %q, want %q", v, got, want)
		}
	}
}

func TestMedianAndClamp(t *testing.T) {
	if medianFloat(nil) != 0 {
		t.Fatal("median(nil) should be 0")
	}
	if medianFloat([]float64{3, 1, 2}) != 2 {
		t.Fatal("median odd wrong")
	}
	if medianFloat([]float64{1, 2, 3, 4}) != 2.5 {
		t.Fatal("median even wrong")
	}
	if clamp100(-5) != 0 || clamp100(150) != 100 || clamp100(50) != 50 {
		t.Fatal("clamp100 wrong")
	}
}
