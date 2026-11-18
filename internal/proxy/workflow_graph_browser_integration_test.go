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
)

func TestWorkflowGraphBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_WORKFLOW_GRAPH_BROWSER_TEST") != "1" {
		t.Skip("opt-in actual workflow graph browser integration")
	}
	chunk, err := browserAuthProviderChunk(appui.EmbeddedFS())
	if err != nil {
		t.Fatal("build and stage React before browser suite")
	}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	h := newBrowserAuthHarnessWithDomainFixtures(t, false)
	h.providerChunk = chunk
	wf := runtimeBranchFixture()
	wf.ID = "browser-graph"
	wf.Name = "브라우저 분기 업무"
	wf.AllowedTeams = "browser-team"
	wf.Enabled = false
	if err := h.db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal("fixture unavailable")
	}
	webDir := browserAuthWebDirectory(t)
	summaryPath := filepath.Join(webDir, "test-results", "workflow-graph-live-summary.json")
	if err := os.Remove(summaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous summary cannot be cleared")
	}
	runBrowserAuthSuite(t, h, webDir, filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "playwright.workflow-graph.config.ts", 3*time.Minute)
	var report struct {
		Status string `json:"status"`
		Tests  []struct {
			Scenario string `json:"scenario"`
			Status   string `json:"status"`
		} `json:"tests"`
	}
	data, err := os.ReadFile(summaryPath)
	if err != nil || json.Unmarshal(data, &report) != nil || report.Status != "passed" || len(report.Tests) != 4 {
		t.Fatal("four fresh workflow graph browser results required")
	}
	seen := map[string]bool{}
	for _, row := range report.Tests {
		if row.Status != "passed" || seen[row.Scenario] {
			t.Fatal("retry or failed scenario")
		}
		seen[row.Scenario] = true
	}
	for i := 1; i <= 4; i++ {
		if !seen["WORKFLOW-GRAPH-LIVE-00"+itoaProxy(i)] {
			t.Fatal("required scenario absent")
		}
	}
	current, found, err := h.db.GetWorkflow(t.Context(), wf.ID)
	if err != nil || !found || current.Flow == nil || current.Name != "브라우저 분기 수정" || !current.Enabled || current.Description != "browser-competing-change" {
		t.Fatal("stored definition differs from reviewed operations")
	}
	versions, err := h.db.ListWorkflowVersions(t.Context(), wf.ID)
	if err != nil || len(versions) != 1 || versions[0].Flow == nil || versions[0].Name != current.Name || versions[0].Description != "" {
		t.Fatal("published snapshot changed or is missing")
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("audit unavailable")
	}
	saves, publishes := 0, 0
	for _, audit := range audits {
		if audit.Action == "workflow.graph_save" {
			saves++
		}
		if audit.Action == "workflow.publish" {
			publishes++
			var value struct {
				Reason string `json:"reason"`
			}
			if json.Unmarshal([]byte(audit.AfterValue), &value) != nil || value.Reason != "browser-graph-publication" {
				t.Fatal("publication reason missing")
			}
		}
	}
	if saves != 2 || publishes != 1 {
		t.Fatal("unexpected mutation audit count")
	}
	if h.upstream.calls.Load() != 0 || h.upstream.deniedModelCalls.Load() != 0 {
		t.Fatal("editing or publication invoked a model")
	}
}
