package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestPromptDebtScoreClassification(t *testing.T) {
	// Failing prompt dominates regardless of cost.
	_, dt, _ := promptDebtScore(store.PromptFingerprintStat{SuccessRate: 0.5, AvgCostKRW: 1, Requests: 10}, 1, 10)
	if dt != "failing" {
		t.Errorf("low success → failing, got %q", dt)
	}
	// Healthy + cheaper model available → model_waste.
	_, dt, action := promptDebtScore(store.PromptFingerprintStat{SuccessRate: 1, AvgCostKRW: 1, Requests: 10, TopModel: "gpt-4", CheapestModel: "gpt-4o-mini"}, 1, 10)
	if dt != "model_waste" {
		t.Errorf("cheaper model → model_waste, got %q", dt)
	}
	if action == "" {
		t.Error("expected an action hint")
	}
	// Healthy, no waste, expensive vs median → expensive.
	_, dt, _ = promptDebtScore(store.PromptFingerprintStat{SuccessRate: 1, AvgCostKRW: 10, Requests: 10, TopModel: "m", CheapestModel: "m"}, 2, 10)
	if dt != "expensive" {
		t.Errorf("3x median cost → expensive, got %q", dt)
	}
	// Healthy, cheap, just high volume → high_volume.
	_, dt, _ = promptDebtScore(store.PromptFingerprintStat{SuccessRate: 1, AvgCostKRW: 1, Requests: 100, TopModel: "m", CheapestModel: "m"}, 1, 10)
	if dt != "high_volume" {
		t.Errorf("high volume → high_volume, got %q", dt)
	}
	// Healthy, cheap, low volume → minor (filtered out by handler).
	_, dt, _ = promptDebtScore(store.PromptFingerprintStat{SuccessRate: 1, AvgCostKRW: 1, Requests: 10, TopModel: "m", CheapestModel: "m"}, 1, 10)
	if dt != "minor" {
		t.Errorf("healthy → minor, got %q", dt)
	}
}

func TestPromptDebtScoreFailingOutranksHealthy(t *testing.T) {
	bad, _, _ := promptDebtScore(store.PromptFingerprintStat{SuccessRate: 0.3, AvgCostKRW: 1, Requests: 10}, 1, 10)
	ok, _, _ := promptDebtScore(store.PromptFingerprintStat{SuccessRate: 1, AvgCostKRW: 1, Requests: 10, TopModel: "m", CheapestModel: "m"}, 1, 10)
	if bad <= ok {
		t.Fatalf("failing (%v) should score higher than healthy (%v)", bad, ok)
	}
}
