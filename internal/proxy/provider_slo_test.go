package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestEvaluateProviderSLOs(t *testing.T) {
	slos := []store.ProviderSLO{
		{Provider: "openai", AvailabilityTarget: 0.99, P95LatencyTargetMS: 2000, ErrorRateTarget: 0.02, FallbackRateTarget: 0.05, Enabled: true},
		{Provider: "anthropic", AvailabilityTarget: 0.99, Enabled: true},
		{Provider: "idle", AvailabilityTarget: 0.99, Enabled: true}, // no traffic
	}
	scores := []store.ProviderHealthScore{
		// openai: 100 reqs, 10 5xx → availability .90 (< .99 breach), p95 3000 (> 2000 breach), error .10 (> .02 breach)
		{Provider: "openai", Requests: 100, Rate5xx: 10, P95LatencyMS: 3000, FallbackRate: 0.01},
		// anthropic: healthy
		{Provider: "anthropic", Requests: 100, Rate5xx: 0, P95LatencyMS: 500, FallbackRate: 0},
	}

	evals := evaluateProviderSLOs(slos, scores)
	byProvider := map[string]providerSLOEvaluation{}
	for _, e := range evals {
		byProvider[e.Provider] = e
	}

	openai := byProvider["openai"]
	if !openai.Breached {
		t.Error("openai should breach SLO")
	}
	if !openai.Metrics["availability"].Breached {
		t.Errorf("openai availability should breach: %+v", openai.Metrics["availability"])
	}
	if !openai.Metrics["p95_latency_ms"].Breached {
		t.Error("openai p95 should breach")
	}
	if !openai.Metrics["error_rate"].Breached {
		t.Error("openai error rate should breach")
	}
	if openai.Metrics["fallback_rate"].Breached {
		t.Error("openai fallback rate should NOT breach (.01 < .05)")
	}

	if byProvider["anthropic"].Breached {
		t.Error("anthropic should not breach")
	}

	// No traffic → not breached (can't evaluate), requests 0.
	idle := byProvider["idle"]
	if idle.Breached {
		t.Error("idle provider with no traffic should not be flagged as breached")
	}
}
