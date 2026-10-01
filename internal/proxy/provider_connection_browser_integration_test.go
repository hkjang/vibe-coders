//go:build linux

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// The browser uses real local authentication, the embedded React UI and the
// real provider APIs. The only model responder is a loopback catalogue fixture.
// Raw browser output and artifacts are suppressed because drafts contain keys.
func TestProviderConnectionBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_PROVIDER_CONNECTION_BROWSER_TEST") != "1" {
		t.Skip("opt-in real provider connection browser integration")
	}
	webDir := browserAuthWebDirectory(t)
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLog) })
	h := newBrowserAuthHarness(t)
	key := browserFixtureSecret(t)
	const name = "provider-browser-live"
	var calls, unsafeCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/draft/v1/models" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer "+key {
			unsafeCalls.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		provider, found, err := h.db.GetProvider(r.Context(), name)
		// The first check precedes creation. The second uses the stored key
		// while an edited timeout is still a draft, not yet saved.
		if err != nil || (call == 1 && found) || (call == 2 && (!found || provider.TimeoutMS != 30000)) || call > 2 {
			unsafeCalls.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"private-local-model"}]}`)
	}))
	t.Cleanup(upstream.Close)
	summaryPath := filepath.Join(h.childScratch, "provider-connection-summary.json")
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", "playwright.provider-connection.config.ts")
	cmd.Dir = webDir
	cmd.Env = append(h.childEnvironment(),
		"VIBE_PROVIDER_CONNECTION_BROWSER_TEST=1", "VIBE_PROVIDER_CONNECTION_URL="+upstream.URL+"/draft",
		"VIBE_PROVIDER_CONNECTION_KEY="+key, "VIBE_PROVIDER_CONNECTION_SUMMARY="+summaryPath)
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
	err := cmd.Run()
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	var summary struct {
		Passed     bool `json:"passed"`
		TestCount  int  `json:"test_count"`
		SourceLine int  `json:"source_line"`
	}
	file, openErr := os.Open(summaryPath)
	if openErr != nil {
		t.Fatal("provider browser runner did not produce its private safe summary; raw output suppressed")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&summary) != nil || summary.SourceLine < 0 || summary.SourceLine > 10000 {
		t.Fatal("provider browser summary invalid; raw output suppressed")
	}
	if err != nil || !summary.Passed || summary.TestCount != 1 {
		t.Fatalf("provider browser workflow failed at source line %d; raw output suppressed", summary.SourceLine)
	}
	if calls.Load() != 2 || unsafeCalls.Load() != 0 {
		t.Fatal("provider checks retried, bypassed draft boundaries, or reached an unexpected upstream operation")
	}
	provider, found, err := h.db.GetProvider(t.Context(), name)
	if err != nil || !found || provider.TimeoutMS != 30000 || provider.EncryptedAPIKey == "" {
		t.Fatal("explicit create or unsaved edit persistence boundary failed")
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal("provider action audit unavailable")
	}
	checks := 0
	for _, audit := range audits {
		if audit.Action == "provider.connection_test" {
			checks++
		}
	}
	if checks != 2 {
		t.Fatal("expected one action audit per actual pre-save check")
	}
}
