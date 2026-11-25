//go:build linux

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"vibe-coders/internal/appui"
	"vibe-coders/internal/store"
)

// Business responses are synthetic; the embedded UI, observation intake and
// persisted summary are real. Authentication has its separate browser suite.
func TestAppUIActionsBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_APPUI_ACTIONS_BROWSER_TEST") != "1" {
		t.Skip("opt-in embedded UI action observation integration")
	}
	if _, err := browserAuthProviderChunk(appui.EmbeddedFS()); err != nil {
		t.Fatal("build and stage React before the browser suite")
	}
	s := newAppUITelemetryTestServer(t)
	s.appUIRuntime.Store(&appUIRuntimeConfig{Enabled: true, TelemetryEnabled: true, LegacyFallback: true})
	gateway := httptest.NewServer(s.Routes())
	t.Cleanup(gateway.Close)
	webDir := browserAuthWebDirectory(t)
	scratch := t.TempDir()
	reportPath := filepath.Join(scratch, "report.json")
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"),
		"test", "console-action-observability.spec.ts", "--grep", "실제 Go 관측 수집과 저장 결과",
		"--workers=1", "--retries=0", "--trace=off", "--reporter=json", "--output="+filepath.Join(scratch, "artifacts"))
	cmd.Dir = webDir
	for _, key := range []string{"PATH", "HOME", "LANG", "PLAYWRIGHT_BROWSERS_PATH", "APP_UI_ACTIONS_HEADER_VERSION"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "CI=true", "APP_BASE_URL="+gateway.URL+"/app/", "APP_UI_ACTIONS_LIVE=1",
		"APP_UI_ACTIONS_VERSION="+AppVersion, "PLAYWRIGHT_JSON_OUTPUT_FILE="+reportPath, "TMPDIR="+scratch)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
	runErr := cmd.Run()
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	var report struct {
		Stats struct {
			Expected   int `json:"expected"`
			Unexpected int `json:"unexpected"`
			Skipped    int `json:"skipped"`
			Flaky      int `json:"flaky"`
		} `json:"stats"`
		Errors []json.RawMessage `json:"errors"`
	}
	raw, err := os.ReadFile(reportPath)
	if err != nil || json.Unmarshal(raw, &report) != nil || runErr != nil || report.Stats.Expected != 4 ||
		report.Stats.Unexpected != 0 || report.Stats.Skipped != 0 || report.Stats.Flaky != 0 || len(report.Errors) != 0 {
		t.Fatalf("four fresh observation scenarios must pass without retries; passed=%d failed=%d skipped=%d flaky=%d",
			report.Stats.Expected, report.Stats.Unexpected, report.Stats.Skipped, report.Stats.Flaky)
	}
	now := time.Now().UTC()
	result, err := s.db.AppUIActionsSummary(t.Context(), now.Add(-time.Hour), now, []string{"system.settings"})
	if err != nil || result.AppUIActionCounts != (store.AppUIActionCounts{Success: 2, Rejected: 1, Unknown: 1}) {
		t.Fatal("browser results and persisted action counts disagree")
	}
}
