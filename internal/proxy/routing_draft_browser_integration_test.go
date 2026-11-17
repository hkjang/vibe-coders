//go:build linux

package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"vibe-coders/internal/appui"
)

// Actual React -> Go -> SQLite. This independent database permits one reviewed
// edit and one competing legacy edit, with no external model calls.
func TestRoutingDraftBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_ROUTING_DRAFT_BROWSER_TEST") != "1" {
		t.Skip("opt-in actual routing draft browser integration")
	}
	chunk, err := browserAuthProviderChunk(appui.EmbeddedFS())
	if err != nil {
		t.Fatal("build and stage React assets before compiling the browser suite")
	}
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLog) })
	h := newBrowserAuthHarnessWithDomainFixtures(t, false)
	h.providerChunk = chunk
	seedBrowserRoutingOrderFixture(t, h.db)
	before, err := h.db.GetRoutingOrderSnapshot(t.Context())
	if err != nil {
		t.Fatal("initial fixture unavailable")
	}
	webDir := browserAuthWebDirectory(t)
	summaryPath := filepath.Join(webDir, "test-results", "routing-draft-live-summary.json")
	if err := os.Remove(summaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous report cannot be cleared")
	}
	runBrowserAuthSuite(t, h, webDir, filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "playwright.routing-draft.config.ts", 2*time.Minute)
	var report struct {
		Status string `json:"status"`
		Tests  []struct {
			Scenario string `json:"scenario"`
			Status   string `json:"status"`
		} `json:"tests"`
	}
	data, err := os.ReadFile(summaryPath)
	if err != nil || json.Unmarshal(data, &report) != nil || report.Status != "passed" || len(report.Tests) != 3 {
		t.Fatal("three fresh draft browser results required")
	}
	seen := map[string]bool{}
	for _, row := range report.Tests {
		if row.Status != "passed" || seen[row.Scenario] {
			t.Fatal("browser scenarios must pass without retries or skips")
		}
		seen[row.Scenario] = true
	}
	for i := 1; i <= 3; i++ {
		if !seen["ROUTING-DRAFT-LIVE-00"+itoaProxy(i)] {
			t.Fatal("required draft browser scenario missing")
		}
	}
	after, err := h.db.GetRoutingOrderSnapshot(t.Context())
	if err != nil {
		t.Fatal("stored result unavailable")
	}
	want := before.Rules
	for i := range want {
		if want[i].ID == "browser-order-a" {
			want[i].TargetModel = "browser-draft-candidate"
			want[i].Note = "draft-conflict-fixture"
		}
	}
	if !reflect.DeepEqual(want, after.Rules) {
		t.Fatal("browser edit changed unexpected configuration or failed to persist")
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("audit unavailable")
	}
	reviewed, legacy := 0, 0
	for _, row := range audits {
		if row.Action == "routing_rule.update" {
			legacy++
		}
		if row.Action != "routing_rule.reviewed_update" {
			continue
		}
		reviewed++
		var value struct {
			Reason string `json:"reason"`
			Rule   struct {
				ID    string `json:"id"`
				Model string `json:"target_model"`
			} `json:"rule"`
		}
		if row.AdminID == "" || json.Unmarshal([]byte(row.AfterValue), &value) != nil || value.Reason != "browser-draft-reviewed" || value.Rule.ID != "browser-order-a" || value.Rule.Model != "browser-draft-candidate" {
			t.Fatal("reviewed audit differs from user action")
		}
	}
	if reviewed != 1 || legacy != 1 {
		t.Fatal("unexpected mutation audit count")
	}
	if h.upstream.calls.Load() != 0 || h.upstream.deniedModelCalls.Load() != 0 {
		t.Fatal("draft preview or save called the model")
	}
}
