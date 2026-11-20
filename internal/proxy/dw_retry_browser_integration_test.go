//go:build linux

package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/appui"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestDwRetryBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_DW_RETRY_BROWSER_TEST") != "1" {
		t.Skip("opt-in actual DW retry browser integration")
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
	now := time.Now().UTC().Add(-time.Minute)
	day := now.In(time.FixedZone("KST", 9*3600)).Format("2006-01-02")
	if err := h.db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: "browser-dw-source", Model: "browser-dw-model", CreatedAt: now, StatusCode: 200}}); err != nil {
		t.Fatal("source unavailable")
	}
	if err := h.db.RollupDay(t.Context(), day); err != nil {
		t.Fatal("rollup unavailable")
	}
	if err := h.db.RecordClickHouseSinkFailure(t.Context(), "model", day, "synthetic pending delivery"); err != nil {
		t.Fatal("queue unavailable")
	}
	var calls, accepted atomic.Int64
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if r.Method == http.MethodPost && strings.HasPrefix(query, "INSERT INTO ") {
			calls.Add(1)
			raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				w.WriteHeader(500)
				return
			}
			text := strings.TrimSpace(string(raw))
			if text != "" {
				accepted.Add(int64(len(strings.Split(text, "\n"))))
			}
			w.WriteHeader(200)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[],"rows":0}`)
	}))
	defer sink.Close()
	h.server.chRuntime.Store(&config.ClickHouseConfig{URL: sink.URL, Table: "browser_dw_rollup", SinkDays: 3})
	webDir := browserAuthWebDirectory(t)
	summaryPath := filepath.Join(webDir, "test-results", "dw-retry-live-summary.json")
	if err := os.Remove(summaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous report unavailable")
	}
	runBrowserAuthSuite(t, h, webDir, filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "playwright.dw-retry.config.ts", 2*time.Minute)
	var report struct {
		Status string `json:"status"`
		Tests  []struct {
			Scenario string `json:"scenario"`
			Status   string `json:"status"`
		} `json:"tests"`
	}
	raw, err := os.ReadFile(summaryPath)
	if err != nil || json.Unmarshal(raw, &report) != nil || report.Status != "passed" || len(report.Tests) != 2 {
		t.Fatal("two fresh DW browser scenarios required")
	}
	seen := map[string]bool{}
	for _, row := range report.Tests {
		if row.Status != "passed" || seen[row.Scenario] {
			t.Fatal("failed or repeated scenario")
		}
		seen[row.Scenario] = true
	}
	if !seen["DW-RETRY-LIVE-001"] || !seen["DW-RETRY-LIVE-002"] {
		t.Fatal("required scenario missing")
	}
	if calls.Load() != 1 || accepted.Load() != 1 {
		t.Fatal("positive delivery or idempotency failed")
	}
	queue, err := h.db.ListClickHouseSinkRetries(t.Context())
	if err != nil || len(queue) != 0 {
		t.Fatal("confirmed delivery left unexpected pending work")
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("audit unavailable")
	}
	requested, completed := 0, 0
	runID := ""
	for _, audit := range audits {
		if audit.Action != "dw.clickhouse.retry.requested" && audit.Action != "dw.clickhouse.retry.completed" {
			continue
		}
		var payload struct {
			OperationID string `json:"operation_id"`
			Reason      string `json:"reason"`
		}
		if json.Unmarshal([]byte(audit.AfterValue), &payload) != nil || payload.Reason != "browser-dw-reviewed-recovery" || audit.AdminID != "browser-local-admin" {
			t.Fatal("actor or reviewed reason absent")
		}
		if runID != "" && runID != payload.OperationID {
			t.Fatal("different operation audited")
		}
		runID = payload.OperationID
		if audit.Action == "dw.clickhouse.retry.requested" {
			requested++
		} else {
			completed++
		}
	}
	run, found, err := h.db.ClickHouseSinkRun(t.Context(), runID)
	if requested != 1 || completed != 1 || err != nil || !found || run.Actor != "browser-local-admin" || run.Status != "succeeded" || run.Progress.EstimatedRows != 1 || run.Progress.SentRows != accepted.Load() {
		t.Fatal("durable result, source estimate and actual sink delivery disagree")
	}
	if h.upstream.calls.Load() != 0 {
		t.Fatal("DW retry unexpectedly called an AI model")
	}
}
