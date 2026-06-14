package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestEligibleNextStage(t *testing.T) {
	c := defaultPromotionCriteria()

	// Experiment with enough clean traffic → validation.
	good := store.PromptVersionStat{Calls: 30, ErrorRate: 0.05, EvalFailRate: 0.10}
	if got := eligibleNextStage(store.PromptStageExperiment, good, c); got != store.PromptStageValidation {
		t.Errorf("experiment+good = %q, want validation", got)
	}
	// Experiment with too few calls → not eligible.
	if got := eligibleNextStage(store.PromptStageExperiment, store.PromptVersionStat{Calls: 5, ErrorRate: 0}, c); got != "" {
		t.Errorf("experiment+few-calls = %q, want ''", got)
	}
	// Experiment with high error rate → not eligible.
	if got := eligibleNextStage(store.PromptStageExperiment, store.PromptVersionStat{Calls: 30, ErrorRate: 0.5}, c); got != "" {
		t.Errorf("experiment+high-error = %q, want ''", got)
	}
	// Validation meeting the stricter bar → production.
	prod := store.PromptVersionStat{Calls: 60, ErrorRate: 0.02, EvalFailRate: 0.05}
	if got := eligibleNextStage(store.PromptStageValidation, prod, c); got != store.PromptStageProduction {
		t.Errorf("validation+great = %q, want production", got)
	}
	// Validation that only meets the looser bar → not promoted to production.
	if got := eligibleNextStage(store.PromptStageValidation, store.PromptVersionStat{Calls: 30, ErrorRate: 0.08}, c); got != "" {
		t.Errorf("validation+marginal = %q, want ''", got)
	}
	// Production is terminal.
	if got := eligibleNextStage(store.PromptStageProduction, prod, c); got != "" {
		t.Errorf("production = %q, want ''", got)
	}
}
