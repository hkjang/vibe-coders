package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
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

func TestProviderSLOAppProjectionUsesOpaqueProviderRefsWithoutChangingLegacyShape(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	unsafeProvider := "sk-ant-legacy-slo-provider-secret"
	for _, slo := range []store.ProviderSLO{
		{Provider: unsafeProvider, AvailabilityTarget: 0.99, Enabled: true},
		{Provider: "safe-provider", AvailabilityTarget: 0.95, Enabled: true},
	} {
		candidate := slo
		if err := db.UpsertProviderSLO(t.Context(), &candidate); err != nil {
			t.Fatal(err)
		}
	}

	legacy, err := http.Get(gateway.URL + "/admin/providers/slo")
	if err != nil {
		t.Fatal(err)
	}
	legacyBody, _ := io.ReadAll(legacy.Body)
	legacy.Body.Close()
	if legacy.StatusCode != http.StatusOK || !strings.Contains(string(legacyBody), unsafeProvider) || strings.Contains(string(legacyBody), `"provider_ref"`) {
		t.Fatalf("legacy SLO response shape changed: status=%d body=%s", legacy.StatusCode, legacyBody)
	}

	app := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/providers/slo", nil)
	appBody, _ := io.ReadAll(app.Body)
	app.Body.Close()
	if app.StatusCode != http.StatusOK || strings.Contains(string(appBody), unsafeProvider) {
		t.Fatalf("app SLO response leaked unsafe provider: status=%d body=%s", app.StatusCode, appBody)
	}
	var appPayload struct {
		SLOs        []store.ProviderSLO     `json:"slos"`
		Evaluations []providerSLOEvaluation `json:"evaluations"`
	}
	if err := json.Unmarshal(appBody, &appPayload); err != nil {
		t.Fatal(err)
	}
	wantUnsafeRef := server.providerRef(unsafeProvider)
	assertProjection := func(provider, providerRef string) {
		t.Helper()
		switch providerRef {
		case wantUnsafeRef:
			if provider != "[provider-name-omitted]" {
				t.Fatalf("unsafe SLO label = %q", provider)
			}
		case server.providerRef("safe-provider"):
			if provider != "safe-provider" {
				t.Fatalf("safe SLO label = %q", provider)
			}
		default:
			t.Fatalf("unexpected SLO provider_ref = %q", providerRef)
		}
	}
	for _, slo := range appPayload.SLOs {
		assertProjection(slo.Provider, slo.ProviderRef)
	}
	for _, evaluation := range appPayload.Evaluations {
		assertProjection(evaluation.Provider, evaluation.ProviderRef)
	}
	if len(appPayload.SLOs) != 2 || len(appPayload.Evaluations) != 2 {
		t.Fatalf("app SLO projection = %+v / %+v", appPayload.SLOs, appPayload.Evaluations)
	}

	updated := providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/providers/slo", map[string]any{
		"provider": unsafeProvider, "availability_target": 0.98, "enabled": true,
	})
	updatedBody, _ := io.ReadAll(updated.Body)
	updated.Body.Close()
	if updated.StatusCode != http.StatusCreated || strings.Contains(string(updatedBody), unsafeProvider) || !strings.Contains(string(updatedBody), wantUnsafeRef) {
		t.Fatalf("app SLO update projection: status=%d body=%s", updated.StatusCode, updatedBody)
	}
	deleted := providerAppRequest(t, http.MethodDelete, gateway.URL+"/admin/providers/slo?provider="+url.QueryEscape(unsafeProvider), nil)
	deletedBody, _ := io.ReadAll(deleted.Body)
	deleted.Body.Close()
	if deleted.StatusCode != http.StatusOK || strings.Contains(string(deletedBody), unsafeProvider) || !strings.Contains(string(deletedBody), wantUnsafeRef) {
		t.Fatalf("app SLO delete projection: status=%d body=%s", deleted.StatusCode, deletedBody)
	}
	audits, err := db.ListAdminAudit(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, audit := range audits {
		values := audit.BeforeValue + audit.AfterValue
		if strings.Contains(values, unsafeProvider) || strings.Contains(values, "provider_ref") {
			t.Fatalf("SLO audit persisted unsafe or rotating identity: %+v", audit)
		}
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
