package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestProviderSLOWriteReturnsPersistedTimestamp(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	createdResponse := postJSON(t, gateway.URL+"/admin/providers/slo", "", map[string]any{
		"provider": "openai", "availability_target": 0.99, "enabled": true,
	})
	defer createdResponse.Body.Close()
	if createdResponse.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createdResponse.Body)
		t.Fatalf("create provider SLO status = %d body=%s", createdResponse.StatusCode, body)
	}
	var created struct {
		SLO store.ProviderSLO `json:"slo"`
	}
	if err := json.NewDecoder(createdResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339Nano, created.SLO.UpdatedAt); err != nil {
		t.Fatalf("created updated_at = %q: %v", created.SLO.UpdatedAt, err)
	}

	listedResponse, err := http.Get(gateway.URL + "/admin/providers/slo")
	if err != nil {
		t.Fatal(err)
	}
	defer listedResponse.Body.Close()
	if listedResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(listedResponse.Body)
		t.Fatalf("list provider SLOs status = %d body=%s", listedResponse.StatusCode, body)
	}
	var listed struct {
		SLOs []store.ProviderSLO `json:"slos"`
	}
	if err := json.NewDecoder(listedResponse.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.SLOs) != 1 || listed.SLOs[0].UpdatedAt != created.SLO.UpdatedAt {
		t.Fatalf("listed SLOs = %+v, want created updated_at %q", listed.SLOs, created.SLO.UpdatedAt)
	}
}

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
	if len(openai.Metrics) != 4 {
		t.Fatalf("openai metrics = %#v, want exactly four documented metrics", openai.Metrics)
	}
	for _, name := range []string{"availability", "p95_latency_ms", "error_rate", "fallback_rate"} {
		if _, ok := openai.Metrics[name]; !ok {
			t.Errorf("openai metrics missing %q: %#v", name, openai.Metrics)
		}
	}
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
