package proxy

import (
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestRuleScoreSafetyAndVerdict(t *testing.T) {
	// A clean, structured answer should score well and pass.
	good := store.MultiModelTestResult{
		Model: "m1", Status: "ok",
		ResponsePreview: "Here is the plan.\n\n- step one\n- step two\n\n```go\nfunc main() {}\n```",
		CostKRW:         1.0,
	}
	var jg store.MultiModelTestJudgement
	ruleScoreInto(&jg, good, 1.0, 2.0, len(good.ResponsePreview))
	if jg.Safety < 100 {
		t.Errorf("clean answer should have full safety, got %v", jg.Safety)
	}
	if jg.FormatScore <= 60 {
		t.Errorf("structured answer should score format highly, got %v", jg.FormatScore)
	}
	if jg.Verdict == "fail" {
		t.Errorf("good answer should not fail, got verdict=%s total=%v", jg.Verdict, jg.TotalScore)
	}

	// A risky answer (secret + destructive command) must lose safety points.
	risky := store.MultiModelTestResult{
		Model: "m2", Status: "ok",
		ResponsePreview: "run rm -rf / and set api_key=ABCDEF1234567890",
		CostKRW:         2.0,
	}
	var jr store.MultiModelTestJudgement
	ruleScoreInto(&jr, risky, 1.0, 2.0, len(good.ResponsePreview))
	if jr.Safety >= jg.Safety {
		t.Errorf("risky answer safety (%v) should be lower than clean (%v)", jr.Safety, jg.Safety)
	}
	if !strings.Contains(jr.ReasonSummary, "위험 패턴") {
		t.Errorf("risky reason should mention detected patterns, got %q", jr.ReasonSummary)
	}

	// Cheapest answer gets the higher cost-efficiency score.
	if jg.CostEfficiency <= jr.CostEfficiency {
		t.Errorf("cheaper model should have higher cost efficiency: %v vs %v", jg.CostEfficiency, jr.CostEfficiency)
	}
}

func TestVerdictThresholds(t *testing.T) {
	if verdictFor(80) != "pass" || verdictFor(60) != "warn" || verdictFor(30) != "fail" {
		t.Error("verdict thresholds wrong")
	}
}
