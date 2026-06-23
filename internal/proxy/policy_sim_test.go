package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestEvaluatePolicyRulesSimulation(t *testing.T) {
	rules := []store.PolicyRule{
		{Name: "block expensive model", Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"gpt-5*"}}},
		{Name: "approve high risk", Conditions: map[string]any{"risk_score": ">80"}, Actions: map[string]any{"require_approval": true}},
	}

	// Blocked by deny_models glob.
	d := evaluatePolicyRules(rules, governanceContext{Model: "gpt-5-turbo", RiskScore: 10})
	if !d.Blocked {
		t.Errorf("expected gpt-5-turbo to be blocked, got %+v", d)
	}

	// High risk, allowed model → require approval.
	d = evaluatePolicyRules(rules, governanceContext{Model: "gpt-4.1-mini", RiskScore: 90})
	if d.Blocked {
		t.Errorf("gpt-4.1-mini should not be blocked: %+v", d)
	}
	if !d.RequireApproval {
		t.Errorf("risk 90 should require approval: %+v", d)
	}

	// Low risk, allowed model → clean allow.
	d = evaluatePolicyRules(rules, governanceContext{Model: "gpt-4.1-mini", RiskScore: 5})
	if d.Blocked || d.RequireApproval {
		t.Errorf("expected clean allow, got %+v", d)
	}
}

func TestCanaryBucketStable(t *testing.T) {
	// Deterministic and within range.
	b := canaryBucket("subject-abc")
	if b < 0 || b > 99 {
		t.Fatalf("bucket out of range: %d", b)
	}
	if canaryBucket("subject-abc") != b {
		t.Fatal("bucket must be stable for the same subject")
	}
}

func TestCanaryRolloutGating(t *testing.T) {
	denyRule := []store.PolicyRule{
		{Name: "block model", Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"gpt-5*"}}, RolloutPercent: 50},
	}
	// Find one subject inside the 50% canary slice and one outside.
	var inside, outside string
	for _, s := range []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"} {
		if canaryBucket(s) < 50 {
			inside = s
		} else {
			outside = s
		}
	}
	if inside == "" || outside == "" {
		t.Skip("could not find both in/out canary subjects in sample")
	}
	// Inside the slice → enforced (blocked).
	if d := evaluatePolicyRules(denyRule, governanceContext{Model: "gpt-5-x", SubjectID: inside}); !d.Blocked {
		t.Errorf("subject %q inside canary slice should be blocked", inside)
	}
	// Outside the slice → not enforced, but a shadow decision is recorded.
	outsideD := evaluatePolicyRules(denyRule, governanceContext{Model: "gpt-5-x", SubjectID: outside})
	if outsideD.Blocked {
		t.Errorf("subject %q outside canary slice should NOT be blocked", outside)
	}
	shadow := false
	for _, e := range outsideD.PolicyEvents {
		if e.Decision == "canary_shadow" {
			shadow = true
		}
	}
	if !shadow {
		t.Errorf("outside-slice canary should record a canary_shadow event, got %+v", outsideD.PolicyEvents)
	}
	// Simulator context (no SubjectID) → full impact regardless of rollout.
	if d := evaluatePolicyRules(denyRule, governanceContext{Model: "gpt-5-x"}); !d.Blocked {
		t.Error("simulation (no SubjectID) should show full enforcement impact")
	}
	// 100% rollout always enforces.
	full := []store.PolicyRule{{Name: "block", Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"gpt-5*"}}, RolloutPercent: 100}}
	if d := evaluatePolicyRules(full, governanceContext{Model: "gpt-5-x", SubjectID: outside}); !d.Blocked {
		t.Error("100% rollout should always enforce")
	}
}
