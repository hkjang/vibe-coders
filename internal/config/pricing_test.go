package config

import (
	"strings"
	"testing"
)

// Cost enforcement is a `cost > limit` comparison, so a negative unit price would make
// every request on that model look free-or-better and quietly disable the budget and the
// cost guard. Loading must fail instead of booting with unenforceable limits.
func TestLoadRejectsNegativeModelPricing(t *testing.T) {
	for name, raw := range map[string]string{
		"input":  `{"gpt-4o":{"input_krw_per_1m":-1,"output_krw_per_1m":2}}`,
		"output": `{"gpt-4o":{"input_krw_per_1m":1,"output_krw_per_1m":-2}}`,
		"cached": `{"gpt-4o":{"input_krw_per_1m":1,"output_krw_per_1m":2,"cached_input_krw_per_1m":-0.5}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("MODEL_PRICING_KRW_PER_1M", raw)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), "must be non-negative") {
				t.Fatalf("Load() error = %v, want a non-negative pricing error", err)
			}
			if !strings.Contains(err.Error(), "gpt-4o") {
				t.Errorf("Load() error = %q, want the offending model named", err)
			}
		})
	}
}

func TestLoadAcceptsZeroAndPositiveModelPricing(t *testing.T) {
	t.Setenv("MODEL_PRICING_KRW_PER_1M", `{"free-model":{"input_krw_per_1m":0,"output_krw_per_1m":0},"paid":{"input_krw_per_1m":1.5,"output_krw_per_1m":3}}`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Pricing["paid"].OutputKRWPer1M; got != 3 {
		t.Errorf("paid output price = %g, want 3", got)
	}
	if _, ok := cfg.Pricing["free-model"]; !ok {
		t.Error("zero-priced model should still be configured")
	}
}
