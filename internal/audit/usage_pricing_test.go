package audit

import (
	"testing"

	"vibe-coders/internal/config"
)

func TestEstimateCostFallsBackToQwenPlus(t *testing.T) {
	pricing := map[string]config.ModelPrice{
		"gpt-4.1":   {InputKRWPer1M: 2760, OutputKRWPer1M: 11040},
		"qwen-plus": {InputKRWPer1M: 552, OutputKRWPer1M: 1656},
	}
	usage := Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000}

	// Exact match uses the model's own price.
	if got := EstimateCostKRW("gpt-4.1", usage, pricing); got != 2760+11040 {
		t.Errorf("gpt-4.1 cost = %v, want %v", got, 2760+11040)
	}
	// Unknown model falls back to qwen-plus pricing.
	if got := EstimateCostKRW("some-unlisted-model-2026", usage, pricing); got != 552+1656 {
		t.Errorf("unknown model cost = %v, want qwen-plus %v", got, 552+1656)
	}
	if !ModelPriced("totally-unknown", pricing) {
		t.Error("unknown model should be considered priced via the qwen-plus fallback")
	}

	// Without a qwen-plus entry, unknown models remain unpriced (cost 0).
	noFallback := map[string]config.ModelPrice{"gpt-4.1": pricing["gpt-4.1"]}
	if got := EstimateCostKRW("unknown", usage, noFallback); got != 0 {
		t.Errorf("no fallback entry → unknown cost should be 0, got %v", got)
	}
	if ModelPriced("unknown", noFallback) {
		t.Error("without qwen-plus, unknown model should not be priced")
	}
}

// The builtin catalog holds entries that are prefixes of one another ("gpt-4o" vs
// "gpt-4o-mini", "claude-sonnet-4" vs "claude-sonnet-4-5"), and real model IDs carry a
// version suffix that matches neither exactly. Ranging over the pricing map picked one at
// random, so the same request could be costed at either rate from call to call.
func TestEstimateCostPrefersLongestPrefixMatch(t *testing.T) {
	pricing := map[string]config.ModelPrice{
		"gpt-4o":          {InputKRWPer1M: 3250, OutputKRWPer1M: 13000},
		"gpt-4o-mini":     {InputKRWPer1M: 195, OutputKRWPer1M: 780},
		"claude-sonnet-4": {InputKRWPer1M: 3900, OutputKRWPer1M: 19500},
		"qwen-plus":       {InputKRWPer1M: 552, OutputKRWPer1M: 1656},
	}
	usage := Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000}

	cases := []struct {
		model string
		want  float64
	}{
		{"gpt-4o-mini-2026-06-01", 195 + 780}, // most specific entry, not the "gpt-4o" it also starts with
		{"gpt-4o-2026-06-01", 3250 + 13000},   // only "gpt-4o" is a prefix
		{"claude-sonnet-4-5", 3900 + 19500},   // no exact entry; the shorter family price applies
		{"unlisted-model", 552 + 1656},        // no prefix at all → fallback model
		{"GPT-4O-MINI-2026", 195 + 780},       // matching is case-insensitive
	}
	for _, tc := range cases {
		// Map iteration order varies per range, so repeat to catch a non-deterministic pick.
		for i := 0; i < 50; i++ {
			if got := EstimateCostKRW(tc.model, usage, pricing); got != tc.want {
				t.Fatalf("%s cost = %v, want %v", tc.model, got, tc.want)
			}
		}
	}
}
