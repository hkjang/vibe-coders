package proxy

import (
	"testing"

	"vibe-coders/internal/config"
)

func TestMatchModelGlob(t *testing.T) {
	if !matchModelGlob("gpt-4*,claude-*", "gpt-4o") {
		t.Error("gpt-4o should match gpt-4*")
	}
	if !matchModelGlob("gpt-4*,claude-*", "claude-opus-4-8") {
		t.Error("claude-opus should match claude-*")
	}
	if matchModelGlob("gpt-4*", "gemini-pro") {
		t.Error("gemini should not match gpt-4*")
	}
	if !matchModelGlob("exact-model", "exact-model") {
		t.Error("exact name should match")
	}
	if matchModelGlob("", "anything") {
		t.Error("empty pattern matches nothing")
	}
}

func TestBlendedAndPct(t *testing.T) {
	b := blendedKRWPer1M(config.ModelPrice{InputKRWPer1M: 1000, OutputKRWPer1M: 3000})
	if b != 2000 {
		t.Errorf("blended = %v, want 2000", b)
	}
	if pctOf(25, 100) != 25 {
		t.Errorf("pctOf(25,100) = %v, want 25", pctOf(25, 100))
	}
	if pctOf(1, 0) != 0 {
		t.Error("pctOf with zero total should be 0")
	}
}
