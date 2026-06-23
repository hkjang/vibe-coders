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
