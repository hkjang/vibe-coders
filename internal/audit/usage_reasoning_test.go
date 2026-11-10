package audit

import (
	"testing"

	"vibe-coders/internal/config"
)

// OpenAI-compatible providers report reasoning tokens as a breakdown of completion_tokens,
// and charging both billed them twice. The total says which reporting style a provider uses.
func TestReasoningTokensAreBilledOnce(t *testing.T) {
	prices := map[string]config.ModelPrice{"m": {OutputKRWPer1M: 1_000_000}}
	for _, tc := range []struct {
		name  string
		usage Usage
		want  float64
	}{
		{"inside completion, total agrees", Usage{PromptTokens: 200, CompletionTokens: 1000, TotalTokens: 1200, ReasoningTokens: 800}, 1000},
		{"reported separately, total counts it", Usage{PromptTokens: 200, CompletionTokens: 1000, TotalTokens: 2000, ReasoningTokens: 800}, 1800},
		{"no total: read as included", Usage{PromptTokens: 200, CompletionTokens: 1000, ReasoningTokens: 800}, 1000},
		{"a total matching neither: read as included", Usage{PromptTokens: 200, CompletionTokens: 1000, TotalTokens: 1500, ReasoningTokens: 800}, 1000},
		{"no reasoning", Usage{PromptTokens: 200, CompletionTokens: 1000, TotalTokens: 1200}, 1000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := EstimateCostKRW("m", tc.usage, prices); got != tc.want {
				t.Fatalf("cost = %v, want %v", got, tc.want)
			}
		})
	}
}
