//go:build linux

package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/appui"
	"vibe-coders/internal/store"
)

// This suite calls the real preview/simulation endpoints from the embedded UI.
// It owns a separate database: no order-save, policy-save or model-call test can
// hide a write or upstream call caused by a supposedly read-only calculation.
func TestSimulationBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_SIMULATION_BROWSER_TEST") != "1" {
		t.Skip("opt-in real simulation browser integration")
	}
	chunk, err := browserAuthProviderChunk(appui.EmbeddedFS())
	if err != nil {
		t.Fatal("build and stage the React assets before compiling this browser test")
	}
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLog) })
	h := newBrowserAuthHarnessWithDomainFixtures(t, false)
	h.providerChunk = chunk
	seedBrowserSimulationFixture(t, h.db)
	before := browserSimulationConfiguration(t, h.db)
	webDir := browserAuthWebDirectory(t)
	summaryPath := filepath.Join(webDir, "test-results", "simulation-live-summary.json")
	if err := os.Remove(summaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous simulation report could not be cleared")
	}
	runBrowserAuthSuite(t, h, webDir, filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "playwright.simulation.config.ts", 2*time.Minute)
	var report struct {
		Status string `json:"status"`
		Tests  []struct {
			Scenario string `json:"scenario"`
			Status   string `json:"status"`
		} `json:"tests"`
	}
	data, err := os.ReadFile(summaryPath)
	if err != nil || json.Unmarshal(data, &report) != nil || report.Status != "passed" || len(report.Tests) != 5 {
		t.Fatal("five fresh simulation browser results are required")
	}
	seen := map[string]bool{}
	for _, row := range report.Tests {
		if row.Status != "passed" || seen[row.Scenario] {
			t.Fatal("simulation results must pass without skips or retries")
		}
		seen[row.Scenario] = true
	}
	for i := 1; i <= 5; i++ {
		if !seen["SIMULATION-LIVE-00"+itoaProxy(i)] {
			t.Fatal("required simulation scenario missing")
		}
	}
	if h.upstream.calls.Load() != 0 || h.upstream.deniedModelCalls.Load() != 0 {
		t.Fatal("simulation must never call the model")
	}
	if browserSimulationConfiguration(t, h.db) != before {
		t.Fatal("simulation changed routing, policies, settings or setting history")
	}
	rows, err := h.db.GovernanceSimContexts(t.Context(), time.Now().UTC().Add(-7*24*time.Hour), 100)
	if err != nil || len(rows) != 8 {
		t.Fatal("simulation changed the eight historical samples")
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("simulation audit verification failed")
	}
	for _, audit := range audits {
		if audit.Action == "policy.create" || audit.Action == "policy.update" || audit.Action == "routing_rule.reorder" {
			t.Fatal("preview unexpectedly recorded a configuration mutation")
		}
	}
}

func seedBrowserSimulationFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	seedBrowserRoutingOrderFixture(t, db)
	if err := db.UpsertPolicyWithRules(t.Context(), store.Policy{ID: "simulation-kept", Name: "기존 검토 정책", Enabled: true, RolloutPercent: 25}, []store.PolicyRule{{ID: "simulation-kept-rule", Enabled: true, Conditions: map[string]any{"model": "unrelated"}, Actions: map[string]any{"block": true}}}); err != nil {
		t.Fatal("simulation policy fixture failed")
	}
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "simulation.contract", Category: "contract", ValueJSON: "17", ValueType: "int"}, "browser-fixture", "isolated fixture"); err != nil {
		t.Fatal("simulation setting fixture failed")
	}
	now := time.Now().UTC()
	// Two baseline days, five recent expensive samples and one unrelated sample.
	// Keep timestamps far from the 24-hour and seven-day boundaries.
	for i := 0; i < 8; i++ {
		when, cost, model := now.Add(-time.Hour), 100.0, "browser-cost-model"
		if i < 2 {
			when, cost = now.Add(-time.Duration(60+i*24)*time.Hour), 1
		}
		if i == 7 {
			cost, model = 2, "browser-other-model"
		}
		id := "browser-simulation-" + itoaProxy(i)
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: id, Model: model, Provider: "test", StatusCode: 200, CreatedAt: when}, Usage: &store.TokenUsage{ID: id + "-usage", RequestID: id, EstimatedCost: cost, Currency: "KRW", CreatedAt: when}}); err != nil {
			t.Fatal("simulation historical fixture failed")
		}
	}
	for i := 0; i < 10; i++ {
		if err := db.InsertSecretEvent(t.Context(), store.SecretEvent{ID: "browser-simulation-secret-" + itoaProxy(i), SecretType: "synthetic", Action: "detect", CreatedAt: now.Add(-time.Hour)}); err != nil {
			t.Fatal("simulation secret metadata fixture failed")
		}
	}
}

func browserSimulationConfiguration(t *testing.T, db *store.SQLStore) string {
	t.Helper()
	policies, err := db.ListPolicies(t.Context())
	if err != nil {
		t.Fatal("policy snapshot unavailable")
	}
	routing, err := db.ListRoutingRules(t.Context())
	if err != nil {
		t.Fatal("routing snapshot unavailable")
	}
	settings, err := db.ListAdminSettings(t.Context())
	if err != nil {
		t.Fatal("settings snapshot unavailable")
	}
	history, err := db.ListAdminSettingHistory(t.Context(), "", 1000)
	if err != nil {
		t.Fatal("settings history snapshot unavailable")
	}
	samples, err := db.GovernanceSimContexts(t.Context(), time.Now().UTC().Add(-7*24*time.Hour), 100)
	if err != nil {
		t.Fatal("historical sample snapshot unavailable")
	}
	data, err := json.Marshal([]any{policies, routing, settings, history, samples})
	if err != nil {
		t.Fatal("configuration snapshot unavailable")
	}
	// Never print this snapshot: settings may contain synthetic credentials.
	return string(data)
}
