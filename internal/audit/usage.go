package audit

import (
	"math"
	"strings"

	"vibe-coders/internal/config"
)

type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	CachedTokens     int
	ReasoningTokens  int
	Source           string
}

func EstimateCostKRW(model string, usage Usage, pricing map[string]config.ModelPrice) float64 {
	price, ok := lookupPrice(model, pricing)
	if !ok {
		return 0
	}
	cached := usage.CachedTokens
	if cached < 0 {
		cached = 0
	}
	if cached > usage.PromptTokens {
		cached = usage.PromptTokens
	}
	freshPrompt := usage.PromptTokens - cached
	cachedRate := price.CachedInputKRWPer1M
	if cachedRate <= 0 {
		cachedRate = price.InputKRWPer1M
	}
	input := float64(freshPrompt)*price.InputKRWPer1M/1_000_000 +
		float64(cached)*cachedRate/1_000_000
	// reasoning tokens are billed as output for OpenAI o-series / Anthropic thinking
	output := float64(usage.CompletionTokens+usage.ReasoningTokens) * price.OutputKRWPer1M / 1_000_000
	return input + output
}

func EstimateTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	words := len(strings.Fields(text))
	byChars := int(math.Ceil(float64(len([]rune(text))) / 4.0))
	if byChars < words {
		return words
	}
	return byChars
}

func lookupPrice(model string, pricing map[string]config.ModelPrice) (config.ModelPrice, bool) {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if normalized == "" {
		return config.ModelPrice{}, false
	}
	if price, ok := pricing[normalized]; ok {
		return price, true
	}
	for key, price := range pricing {
		key = strings.ToLower(strings.TrimSpace(key))
		if key != "" && strings.HasPrefix(normalized, key) {
			return price, true
		}
	}
	return config.ModelPrice{}, false
}
