package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestDecisionOutcome(t *testing.T) {
	cases := []struct {
		d    governanceDecision
		want string
	}{
		{governanceDecision{Blocked: true}, "block"},
		{governanceDecision{RequireApproval: true}, "require_approval"},
		{governanceDecision{Blocked: true, RequireApproval: true}, "block"}, // block dominates
		{governanceDecision{}, "allow"},
	}
	for i, c := range cases {
		if got := decisionOutcome(c.d); got != c.want {
			t.Errorf("case %d: got %q want %q", i, got, c.want)
		}
	}
}

// A regression case + a deny rule should produce the expected "block" outcome when replayed.
func TestPolicyRegressionEvaluation(t *testing.T) {
	rules := []store.PolicyRule{{
		ID: "r1", Name: "deny gpt-4",
		Actions: map[string]any{"deny_models": []any{"gpt-4"}},
	}}
	blocked := evaluatePolicyRules(rules, governanceContext{Model: "gpt-4"})
	if decisionOutcome(blocked) != "block" {
		t.Fatalf("expected block for gpt-4, got %q", decisionOutcome(blocked))
	}
	allowed := evaluatePolicyRules(rules, governanceContext{Model: "gpt-3.5"})
	if decisionOutcome(allowed) != "allow" {
		t.Fatalf("expected allow for gpt-3.5, got %q", decisionOutcome(allowed))
	}
}
