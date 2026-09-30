package proxy

import (
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestStoredMultiModelSuccessStatusCompatibility(t *testing.T) {
	for _, status := range []string{"success", "ok", "", "error", "timeout", "unknown", "SUCCESS", "OK", " success", "ok ", "\u0085success", "ok\uFEFF"} {
		t.Run(status, func(t *testing.T) {
			want := status == "success" || status == "ok"
			if successfulStoredMultiModelStatus(status) != want {
				t.Fatal("only exact current success and legacy ok may be treated as successful")
			}
		})
	}
}

func TestStoredMultiModelJudgePromptSelectsOnlySuccessfulNonemptyResponses(t *testing.T) {
	results := []store.MultiModelTestResult{
		{Model: "public-current", Status: "success", ResponsePreview: "Public current answer"},
		{Model: "public-legacy", Status: "ok", ResponsePreview: "Public legacy answer"},
		{Model: "public-failed", Status: "error", ResponsePreview: "Failed answer must not reach judge"},
		{Model: "public-unknown", Status: "unknown", ResponsePreview: "Unknown answer must not reach judge"},
		{Model: "public-no-status", Status: "", ResponsePreview: "No-status answer must not reach judge"},
		{Model: "public-no-answer", Status: "success", ResponsePreview: ""},
		{Model: "public-blank-answer", Status: "ok", ResponsePreview: " \t\n\u0085"},
	}
	prompt := buildJudgePrompt(store.MultiModelTestRun{}, results)
	for index, result := range results {
		included := strings.Contains(prompt, "=== MODEL: "+result.Model+" ===")
		if included != (index < 2) {
			t.Errorf("judge candidate %d inclusion=%t, want=%t", index, included, index < 2)
		}
		if index < 2 && !strings.Contains(prompt, result.ResponsePreview) {
			t.Error("successful candidate must retain its stored answer")
		}
		if index >= 2 && strings.TrimSpace(result.ResponsePreview) != "" && strings.Contains(prompt, result.ResponsePreview) {
			t.Error("excluded candidate text must not reach the judge model")
		}
	}
}
