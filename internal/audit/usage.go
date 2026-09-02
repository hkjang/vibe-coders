package audit

import (
	"math"
	"strings"
	"sync/atomic"

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

// LookupPrice resolves the price used to cost a model: exact match first, then the
// longest matching catalog prefix, then the configured fallback model. Exported so
// callers outside this package price a model exactly the way cost estimation does
// instead of keeping their own copy of the rules.
func LookupPrice(model string, pricing map[string]config.ModelPrice) (config.ModelPrice, bool) {
	return lookupPrice(model, pricing)
}

// ModelPriced reports whether the model (exact or prefix) has a price entry.
func ModelPriced(model string, pricing map[string]config.ModelPrice) bool {
	_, ok := lookupPrice(model, pricing)
	return ok
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

// DefaultFallbackPriceModel is used until overridden at runtime.
const DefaultFallbackPriceModel = "qwen-plus"

// fallbackPriceModel holds the runtime-adjustable model whose price costs requests whose
// model name matches no exact or prefix entry. Stored atomically so settings changes are
// safe against concurrent cost calculations.
var fallbackPriceModel atomic.Value // string

func init() { fallbackPriceModel.Store(DefaultFallbackPriceModel) }

// SetFallbackPriceModel updates the fallback model used for unmatched models. Empty resets
// to the default.
func SetFallbackPriceModel(model string) {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		m = DefaultFallbackPriceModel
	}
	fallbackPriceModel.Store(m)
}

// FallbackPriceModel returns the current fallback model name.
func FallbackPriceModel() string {
	if v, ok := fallbackPriceModel.Load().(string); ok {
		return v
	}
	return DefaultFallbackPriceModel
}

func lookupPrice(model string, pricing map[string]config.ModelPrice) (config.ModelPrice, bool) {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if normalized == "" {
		return config.ModelPrice{}, false
	}
	if price, ok := pricing[normalized]; ok {
		return price, true
	}
	// Several catalog entries are prefixes of the same versioned model name --
	// "gpt-4o-mini-2026-06" starts with both "gpt-4o" and "gpt-4o-mini", whose input
	// rates differ by ~17x. Ranging over the map would pick either one at random, so
	// the same request could be costed differently on every call. Keep the longest
	// (most specific) match, which is both deterministic and the intended price.
	best, bestLen := config.ModelPrice{}, -1
	for key, price := range pricing {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" || !strings.HasPrefix(normalized, key) {
			continue
		}
		if len(key) > bestLen {
			best, bestLen = price, len(key)
		}
	}
	if bestLen >= 0 {
		return best, true
	}
	// Last resort: cost unmatched models at the fallback model's price (when present).
	if fb, ok := pricing[FallbackPriceModel()]; ok {
		return fb, true
	}
	return config.ModelPrice{}, false
}
