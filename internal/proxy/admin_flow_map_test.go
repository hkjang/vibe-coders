package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestDecisionStatus(t *testing.T) {
	cases := map[string]string{
		"block": "blocked", "deny": "blocked", "reject": "blocked",
		"warn": "warn", "flag": "warn",
		"allow": "ok", "permit": "ok", "ok": "ok", "": "ok",
		"weird": "warn",
	}
	for in, want := range cases {
		if got := decisionStatus(in); got != want {
			t.Errorf("decisionStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPolicyHelpers(t *testing.T) {
	pds := []store.PolicyDecisionEvent{
		{Decision: "allow", RuleName: "baseline"},
		{Decision: "warn", RuleName: "daily budget cap", Reason: "near limit"},
		{Decision: "block", RuleName: "secret guard", Reason: "api key detected"},
	}
	if pd := findPolicyByKeyword(pds, "quota", "budget"); pd == nil || pd.RuleName != "daily budget cap" {
		t.Errorf("keyword lookup failed: %+v", pd)
	}
	if pd := firstBlockingPolicy(pds); pd == nil || pd.RuleName != "secret guard" {
		t.Errorf("blocking lookup failed: %+v", pd)
	}
	if pd := findPolicyByKeyword(pds, "nonexistent"); pd != nil {
		t.Error("absent keyword should return nil")
	}
}

func TestPendingApprovals(t *testing.T) {
	as := []store.Approval{{Status: "pending"}, {Status: "approved"}, {Status: "Pending"}}
	if n := pendingApprovals(as); n != 2 {
		t.Errorf("pendingApprovals = %d, want 2", n)
	}
}
