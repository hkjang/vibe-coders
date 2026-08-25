package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestGlobIntersectionWitnessUsesGatewayWildcardSemantics(t *testing.T) {
	tests := []struct {
		name    string
		left    string
		right   string
		overlap bool
	}{
		{name: "duplicate", left: "gpt-*", right: "GPT-**", overlap: true},
		{name: "prefix and suffix", left: "gpt-*", right: "*-mini", overlap: true},
		{name: "nested literals", left: "a*b*c", right: "a*c", overlap: true},
		{name: "disjoint prefixes", left: "claude-*", right: "gpt-*", overlap: false},
		{name: "catch all", left: "*", right: "vibe/*", overlap: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			witness, overlap := globIntersectionWitness(tt.left, tt.right)
			if overlap != tt.overlap {
				t.Fatalf("overlap=%v witness=%q, want overlap=%v", overlap, witness, tt.overlap)
			}
			if overlap && (!matchGlob(canonicalProviderPattern(tt.left), witness) || !matchGlob(canonicalProviderPattern(tt.right), witness)) {
				t.Fatalf("witness %q does not match both %q and %q", witness, tt.left, tt.right)
			}
		})
	}
}

func TestAnalyzeProviderPatternsReportsDeterministicWinnerAndSimulation(t *testing.T) {
	analysis := analyzeProviderPatterns([]providerPatternSource{
		{Name: "zeta", Enabled: true, ModelPatterns: "*-mini,claude-*"},
		{Name: "disabled", Enabled: false, ModelPatterns: "*"},
		{Name: "alpha", Enabled: true, ModelPatterns: "gpt-*"},
	}, "default", "gpt-4.1-mini", "")

	if analysis.Summary.ConflictCount != 1 {
		t.Fatalf("conflict_count=%d, want 1: %+v", analysis.Summary.ConflictCount, analysis.Conflicts)
	}
	conflict := analysis.Conflicts[0]
	if conflict.Type != "overlapping_pattern" || conflict.SelectedProvider != "alpha" {
		t.Fatalf("unexpected conflict: %+v", conflict)
	}
	if !matchGlob("gpt-*", conflict.WitnessModel) || !matchGlob("*-mini", conflict.WitnessModel) {
		t.Fatalf("invalid overlap witness %q", conflict.WitnessModel)
	}
	if analysis.Simulation == nil || analysis.Simulation.SelectedProvider != "alpha" || !analysis.Simulation.Ambiguous {
		t.Fatalf("unexpected simulation: %+v", analysis.Simulation)
	}
	if got := analysis.ResolutionPolicy.Order; len(got) != 2 || got[0] != "alpha" || got[1] != "zeta" {
		t.Fatalf("resolution order=%v, want [alpha zeta]", got)
	}
}

func TestProviderPatternConflictAPIIncludesNonPersistentPreview(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, provider := range []map[string]any{
		{"name": "alpha", "base_url": upstream.URL, "api_key": "alpha-key", "enabled": true, "model_patterns": "gpt-*"},
		{"name": "zeta", "base_url": upstream.URL, "api_key": "zeta-key", "enabled": true, "model_patterns": "*-mini"},
	} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", provider)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("provider save failed: %d %s", resp.StatusCode, body)
		}
		resp.Body.Close()
	}

	resp, err := http.Get(proxy.URL + "/admin/routing/pattern-conflicts?model=gpt-4.1-mini")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("analysis failed: %d %s", resp.StatusCode, body)
	}
	var current providerPatternAnalysis
	if err := json.NewDecoder(resp.Body).Decode(&current); err != nil {
		t.Fatal(err)
	}
	if current.Summary.ConflictCount != 1 || current.Simulation == nil || current.Simulation.SelectedProvider != "alpha" {
		t.Fatalf("unexpected current analysis: %+v", current)
	}

	previewResp := postJSON(t, proxy.URL+"/admin/routing/pattern-conflicts", "", map[string]any{
		"provider_name":  "aardvark",
		"model_patterns": "gpt-4.1-*",
		"enabled":        true,
		"model":          "gpt-4.1-mini",
	})
	defer previewResp.Body.Close()
	if previewResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(previewResp.Body)
		t.Fatalf("preview failed: %d %s", previewResp.StatusCode, body)
	}
	var preview providerPatternAnalysis
	if err := json.NewDecoder(previewResp.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	if preview.Summary.FocusConflictCount != 2 {
		t.Fatalf("focus conflicts=%d, want 2: %+v", preview.Summary.FocusConflictCount, preview.Conflicts)
	}
	if preview.Simulation == nil || preview.Simulation.SelectedProvider != "aardvark" || !preview.Simulation.Ambiguous {
		t.Fatalf("unexpected preview simulation: %+v", preview.Simulation)
	}
	if _, found, err := db.GetProvider(context.Background(), "aardvark"); err != nil || found {
		t.Fatalf("preview must not persist provider: found=%v err=%v", found, err)
	}
}

// Failover candidates are built only from model_patterns matches, so pattern overlap
// is the sole thing that makes provider failover possible. The analysis must report
// that plainly — a provider with patterns but no overlapping peer is a silent SPOF,
// and a default provider with no patterns can never take part in failover at all.
func TestAnalyzeProviderPatternsReportsFailoverCoverage(t *testing.T) {
	t.Run("mirrored patterns cover each other", func(t *testing.T) {
		analysis := analyzeProviderPatterns([]providerPatternSource{
			{Name: "a-primary", Enabled: true, ModelPatterns: "gpt-*"},
			{Name: "b-backup", Enabled: true, ModelPatterns: "gpt-*"},
		}, "a-primary", "gpt-4.1", "")

		if analysis.Summary.FailoverReadyProviderCount != 2 || analysis.Summary.FailoverUncoveredProviderCount != 0 {
			t.Fatalf("coverage counts ready=%d uncovered=%d, want 2/0",
				analysis.Summary.FailoverReadyProviderCount, analysis.Summary.FailoverUncoveredProviderCount)
		}
		for _, c := range analysis.Coverage {
			if !c.FailoverReady || len(c.FailoverPeers) != 1 {
				t.Fatalf("provider %q not covered: %+v", c.Provider, c)
			}
		}
		sim := analysis.Simulation
		if sim == nil || !sim.FailoverAvailable {
			t.Fatalf("expected failover available: %+v", sim)
		}
		// dialUpstream walks candidates in list order (ORDER BY name ASC), so the
		// alphabetically later provider is the one that takes over.
		if len(sim.FailoverCandidates) != 1 || sim.FailoverCandidates[0] != "b-backup" {
			t.Fatalf("failover candidates=%v, want [b-backup]", sim.FailoverCandidates)
		}
		if !analysis.DefaultProviderHasPatterns {
			t.Fatal("default provider a-primary has patterns but was reported as having none")
		}
	})

	t.Run("disjoint patterns leave every provider uncovered", func(t *testing.T) {
		analysis := analyzeProviderPatterns([]providerPatternSource{
			{Name: "anthropic", Enabled: true, ModelPatterns: "claude-*"},
			{Name: "openai", Enabled: true, ModelPatterns: "gpt-*"},
		}, "openai", "claude-3-5-sonnet", "")

		if analysis.Summary.FailoverUncoveredProviderCount != 2 {
			t.Fatalf("uncovered=%d, want 2", analysis.Summary.FailoverUncoveredProviderCount)
		}
		sim := analysis.Simulation
		if sim == nil || sim.FailoverAvailable || sim.FailoverBlockedReason != "single_matching_provider" {
			t.Fatalf("expected single-provider block, got %+v", sim)
		}
	})

	t.Run("default provider without patterns is flagged", func(t *testing.T) {
		analysis := analyzeProviderPatterns([]providerPatternSource{
			{Name: "anthropic", Enabled: true, ModelPatterns: "claude-*"},
			{Name: "openai", Enabled: true, ModelPatterns: ""},
		}, "openai", "gpt-4.1-mini", "")

		if analysis.DefaultProviderHasPatterns {
			t.Fatal("openai has no patterns but was reported as having some")
		}
		sim := analysis.Simulation
		if sim == nil || sim.SelectedProvider != "openai" || sim.RouteReason != "default" {
			t.Fatalf("expected default routing, got %+v", sim)
		}
		if sim.FailoverBlockedReason != "no_pattern_match_default_provider_only" {
			t.Fatalf("blocked reason=%q, want no_pattern_match_default_provider_only", sim.FailoverBlockedReason)
		}
	})
}
