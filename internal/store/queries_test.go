package store

import "testing"

func TestSelectPromptBaselineVersionPrefersNearestPreviousNumber(t *testing.T) {
	rows := []LLMPromptSummary{
		{PromptVersion: "v10", Calls: 5, LastSeen: "2026-06-07T12:00:00Z"},
		{PromptVersion: "v2", Calls: 99, LastSeen: "2026-06-07T13:00:00Z"},
		{PromptVersion: "v9", Calls: 1, LastSeen: "2026-06-06T12:00:00Z"},
	}
	got, reason := selectPromptBaselineVersion(rows, "v10")
	if got != "v9" {
		t.Fatalf("expected nearest previous version v9, got %q", got)
	}
	if reason != "nearest_previous_version" {
		t.Fatalf("expected nearest_previous_version, got %q", reason)
	}
}

func TestSelectPromptBaselineVersionFallsBackToRecentAndHighVolume(t *testing.T) {
	rows := []LLMPromptSummary{
		{PromptVersion: "canary", Calls: 5, LastSeen: "2026-06-07T12:00:00Z"},
		{PromptVersion: "stable", Calls: 8, LastSeen: "2026-06-07T11:00:00Z"},
		{PromptVersion: "legacy", Calls: 50, LastSeen: "2026-06-06T12:00:00Z"},
	}
	got, reason := selectPromptBaselineVersion(rows, "canary")
	if got != "stable" {
		t.Fatalf("expected most recent fallback stable, got %q", got)
	}
	if reason != "recent_activity_fallback" {
		t.Fatalf("expected recent_activity_fallback, got %q", reason)
	}
}

func TestPromptBaselineCandidatesRanksPreviousVersionsBeforeFallback(t *testing.T) {
	rows := []LLMPromptSummary{
		{PromptVersion: "v10", Calls: 5, LastSeen: "2026-06-07T12:00:00Z"},
		{PromptVersion: "v8", Calls: 12, LastSeen: "2026-06-07T11:00:00Z"},
		{PromptVersion: "v9", Calls: 4, Errors: 1, EvalFailures: 2, AverageLatencyMS: 123, LastSeen: "2026-06-06T12:00:00Z"},
		{PromptVersion: "stable", Calls: 50, LastSeen: "2026-06-07T13:00:00Z"},
	}
	got := promptBaselineCandidates(rows, "v10", 3)
	if len(got) != 3 {
		t.Fatalf("expected 3 candidates, got %#v", got)
	}
	if got[0].PromptVersion != "v9" || got[0].Reason != "nearest_previous_version" {
		t.Fatalf("expected first candidate v9 previous version, got %#v", got)
	}
	if got[0].Calls != 4 || got[0].LastSeen != "2026-06-06T12:00:00Z" {
		t.Fatalf("expected first candidate metadata, got %#v", got[0])
	}
	if got[0].AverageLatencyMS != 123 || got[0].ErrorRate != 0.25 || got[0].EvalFailureRate != 0.5 {
		t.Fatalf("expected first candidate quality metadata, got %#v", got[0])
	}
	if got[1].PromptVersion != "v8" || got[1].Reason != "nearest_previous_version" {
		t.Fatalf("expected second candidate v8 previous version, got %#v", got)
	}
	if got[1].Calls != 12 || got[1].LastSeen != "2026-06-07T11:00:00Z" {
		t.Fatalf("expected second candidate metadata, got %#v", got[1])
	}
	if got[2].PromptVersion != "stable" || got[2].Reason != "recent_activity_fallback" {
		t.Fatalf("expected fallback stable candidate, got %#v", got)
	}
	if got[2].Calls != 50 || got[2].LastSeen != "2026-06-07T13:00:00Z" {
		t.Fatalf("expected fallback candidate metadata, got %#v", got[2])
	}
}

func TestPromptBaselineCandidatesHonorsLimit(t *testing.T) {
	rows := []LLMPromptSummary{
		{PromptVersion: "v5", Calls: 5, LastSeen: "2026-06-07T12:00:00Z"},
		{PromptVersion: "v4", Calls: 4, LastSeen: "2026-06-07T11:00:00Z"},
		{PromptVersion: "v3", Calls: 3, LastSeen: "2026-06-07T10:00:00Z"},
		{PromptVersion: "v2", Calls: 2, LastSeen: "2026-06-07T09:00:00Z"},
	}
	got := promptBaselineCandidates(rows, "v5", 2)
	if len(got) != 2 {
		t.Fatalf("expected 2 candidates, got %#v", got)
	}
	if got[0].PromptVersion != "v4" || got[1].PromptVersion != "v3" {
		t.Fatalf("unexpected limited candidates, got %#v", got)
	}
}
