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
