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
