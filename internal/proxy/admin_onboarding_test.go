package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestAppOnboardingChecklist(t *testing.T) {
	// A complete, well-governed app is ready.
	ready, checks := appOnboardingChecklist(store.WorkApp{
		Title: "리뷰 도우미", Owner: "platform-team", Description: "PR 리뷰 보조",
		AllowedTeams: "alpha", Components: []store.AppComponent{{}},
	})
	if !ready {
		t.Fatalf("complete app should be ready, checks=%+v", checks)
	}
	for _, c := range checks {
		if !c.OK {
			t.Errorf("complete app should pass all checks, failed: %+v", c)
		}
	}

	// Missing owner + components → required checks fail → not ready.
	notReady, checks2 := appOnboardingChecklist(store.WorkApp{Title: "x"})
	if notReady {
		t.Fatal("app without owner/components must not be ready")
	}
	failedRequired := map[string]bool{}
	for _, c := range checks2 {
		if c.Severity == "required" && !c.OK {
			failedRequired[c.Key] = true
		}
	}
	if !failedRequired["owner"] || !failedRequired["components"] {
		t.Fatalf("owner and components should be failing required checks, got %+v", checks2)
	}

	// Missing only recommended (access scope) → still ready, but flagged.
	r3, checks3 := appOnboardingChecklist(store.WorkApp{Title: "t", Owner: "o", Components: []store.AppComponent{{}}})
	if !r3 {
		t.Fatal("app missing only recommended items should still be ready")
	}
	scopeFlagged := false
	for _, c := range checks3 {
		if c.Key == "access_scope" && !c.OK && c.Severity == "recommended" {
			scopeFlagged = true
		}
	}
	if !scopeFlagged {
		t.Fatalf("unscoped app should flag access_scope as a recommended gap, got %+v", checks3)
	}
}

func TestMCPOnboardingChecklist(t *testing.T) {
	// Complete low-risk upstream is ready.
	ready, _ := mcpOnboardingChecklist(store.MCPUpstream{
		Name: "fs", URL: "https://mcp.example/sse",
		Metadata: store.MCPUpstreamMetadata{Description: "files", RiskLevel: "low"},
	})
	if !ready {
		t.Fatal("complete low-risk upstream should be ready")
	}

	// Missing name+url → not ready.
	nr, _ := mcpOnboardingChecklist(store.MCPUpstream{})
	if nr {
		t.Fatal("upstream without name/url must not be ready")
	}

	// High-risk WITHOUT approval gate → required check fails → not ready.
	hr, checks := mcpOnboardingChecklist(store.MCPUpstream{
		Name: "exec", URL: "https://x", Metadata: store.MCPUpstreamMetadata{RiskLevel: "high"},
	})
	if hr {
		t.Fatal("high-risk upstream without approval gate must not be ready")
	}
	gate := false
	for _, c := range checks {
		if c.Key == "approval_gate" && c.Severity == "required" && !c.OK {
			gate = true
		}
	}
	if !gate {
		t.Fatalf("high-risk upstream should require an approval gate, got %+v", checks)
	}

	// High-risk WITH approval gate → ready.
	hr2, _ := mcpOnboardingChecklist(store.MCPUpstream{
		Name: "exec", URL: "https://x", Metadata: store.MCPUpstreamMetadata{RiskLevel: "high", RequiresApproval: true},
	})
	if !hr2 {
		t.Fatal("high-risk upstream with approval gate should be ready")
	}
}
