package proxy

import "testing"

func TestMCPTrustScore(t *testing.T) {
	// Clean, low-risk tool → A.
	if sc, g := mcpTrustScore(0, "low"); sc != 100 || g != "A" {
		t.Errorf("clean low-risk = %v/%s, want 100/A", sc, g)
	}
	// High error rate drops the score.
	sc, g := mcpTrustScore(0.5, "low") // 100 - 25 = 75 → B
	if sc != 75 || g != "B" {
		t.Errorf("50%% errors = %v/%s, want 75/B", sc, g)
	}
	// High risk penalizes.
	if sc, _ := mcpTrustScore(0, "high"); sc != 75 {
		t.Errorf("high risk clean = %v, want 75", sc)
	}
	// Critical risk + errors floors low.
	if sc, g := mcpTrustScore(1.0, "critical"); sc != 15 || g != "D" {
		t.Errorf("worst case = %v/%s, want 15/D", sc, g)
	}
	// Score never negative.
	if sc, _ := mcpTrustScore(2.0, "critical"); sc < 0 {
		t.Errorf("score must clamp at 0, got %v", sc)
	}
}
