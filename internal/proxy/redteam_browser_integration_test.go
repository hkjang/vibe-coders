//go:build linux

package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Actual browser -> authenticated Go routes -> local provider -> isolated SQLite.
// No test routes, API substitutions, deployed accounts or external models.
func TestRedTeamBrowserIntegration(t *testing.T) {
	if os.Getenv("VIBE_REDTEAM_BROWSER_TEST") != "1" {
		t.Skip("opt-in real reviewed Red Team browser workflow")
	}
	webDir := browserAuthWebDirectory(t)
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLog) })
	resetRedTeamEmergencyTest(t)
	h := newBrowserAuthHarness(t)
	key := "vc_sk_" + browserFixtureSecret(t)
	if err := h.db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "browser-redteam-key", Name: "브라우저 레드팀 실행 키", KeyHash: hashProxyKey(key),
		UserID: "browser-local-admin", Team: "browser-team", Role: "admin", Status: "active",
		Scopes: []string{"chat:completion"}, AllowedModels: []string{"test-model", "second-model"},
	}); err != nil {
		t.Fatal("isolated execution key could not be prepared")
	}
	var live, recording, redirect, replay, replayRecording, other, unsafe atomic.Int64
	otherServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		other.Add(1)
		redTeamAdmissionReply(w)
	}))
	t.Cleanup(otherServer.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model     string `json:"model"`
			MaxTokens int    `json:"max_tokens"`
			N         int    `json:"n"`
			Stream    bool   `json:"stream"`
		}
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/v1/chat/completions") ||
			json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&payload) != nil ||
			payload.Model != "test-model" || payload.MaxTokens != 77 || payload.N != 1 || payload.Stream {
			unsafe.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0] {
		case "live":
			live.Add(1)
		case "recording":
			recording.Add(1)
		case "replay":
			replay.Add(1)
		case "replay-recording":
			replayRecording.Add(1)
		case "redirect":
			redirect.Add(1)
			http.Redirect(w, r, otherServer.URL+"/v1/chat/completions", http.StatusTemporaryRedirect)
			return
		default:
			unsafe.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		redTeamAdmissionReply(w)
	}))
	t.Cleanup(upstream.Close)
	seedRedTeamBrowserCampaigns(t, h, upstream.URL)
	verifyReplay := seedRedTeamBrowserReplay(t, h)
	for i := 0; i < 127; i++ {
		if err := h.db.InsertRedTeamRun(t.Context(), store.RedTeamRun{ID: fmt.Sprintf("browser-history-%03d", i), CampaignID: "browser-history", TargetID: "browser-history-target", Mode: "dry-run", Status: "passed", CreatedAt: "2020-01-01T00:00:00Z"}); err != nil {
			t.Fatal("history fixture unavailable")
		}
	}
	// Fault only the intended campaign. The production SQL and handler are unchanged.
	raw, err := sql.Open("sqlite", filepath.Join(filepath.Dir(h.childScratch), "auth.db"))
	if err != nil {
		t.Fatal("isolated recording fault database unavailable")
	}
	defer raw.Close()
	if _, err := raw.ExecContext(t.Context(), `CREATE TRIGGER browser_redteam_recording_failure BEFORE INSERT ON redteam_case_results
		WHEN EXISTS (SELECT 1 FROM redteam_runs WHERE id = NEW.run_id AND campaign_id IN ('browser-redteam-recording', 'browser-redteam-replay-recording'))
		BEGIN SELECT RAISE(ABORT, 'private-browser-recording-fault'); END`); err != nil {
		t.Fatal("isolated recording fault could not be prepared")
	}
	summaryPath := filepath.Join(h.childScratch, "redteam-summary.json")
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(webDir, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", "playwright.redteam.config.ts")
	cmd.Dir = webDir
	cmd.Env = append(h.childEnvironment(), "VIBE_REDTEAM_BROWSER_TEST=1", "VIBE_REDTEAM_BROWSER_KEY="+key, "VIBE_REDTEAM_BROWSER_SUMMARY="+summaryPath)
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
	err = cmd.Run()
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
		t.Fatal("redteam browser safe summary unavailable; raw output suppressed")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&summary) != nil || summary.SourceLine < 0 || summary.SourceLine > 10000 {
		t.Fatal("redteam browser safe summary invalid; raw output suppressed")
	}
	if err != nil || !summary.Passed || summary.TestCount != 11 {
		t.Fatalf("redteam browser failed at source line %d; raw output suppressed", summary.SourceLine)
	}
	if live.Load() != 1 || recording.Load() != 1 || redirect.Load() != 1 || replay.Load() != 1 || replayRecording.Load() != 1 || other.Load() != 0 || unsafe.Load() != 0 {
		t.Fatal("review, retry, redirect or output request boundaries failed")
	}
	verifyRedTeamBrowserStorage(t, h)
	verifyReplay()
	t.Log("Red Team browser: 11/11; actual provider, recording and audit assertions passed")
}

func seedRedTeamBrowserCampaigns(t *testing.T, h *browserAuthHarness, baseURL string) {
	t.Helper()
	provider, found, err := h.db.GetProvider(t.Context(), "test")
	if err != nil || !found || provider.EncryptedAPIKey == "" {
		t.Fatal("isolated provider credential unavailable")
	}
	pack := store.RedTeamProbePack{ID: "browser-redteam-pack", Name: "브라우저 검증 묶음", Enabled: true}
	probe := store.RedTeamProbeCase{ID: "browser-redteam-case", PackID: pack.ID, CaseKey: "browser", InputTemplate: "Public synthetic browser safety probe", ExpectedPolicy: "refuse", Severity: "low", TargetTypes: []string{"model"}}
	if err := h.db.UpsertRedTeamProbePackWithCases(t.Context(), pack, []store.RedTeamProbeCase{probe}); err != nil {
		t.Fatal("isolated probe pack unavailable")
	}
	for _, item := range []struct{ id, name string }{
		{"simulation", "시뮬레이션 확인"}, {"live", "실제 호출 확인"}, {"recording", "저장 실패 확인"},
		{"redirect", "주소 변경 차단"}, {"stale", "검토 변경 확인"},
		{"replay", "한 건 재실행 확인"}, {"replay-recording", "한 건 저장 실패 확인"},
	} {
		p := provider
		p.Name, p.BaseURL, p.ModelPatterns = "browser-redteam-"+item.id, baseURL+"/"+item.id, "test-model"
		if err := h.db.UpsertProvider(t.Context(), p); err != nil {
			t.Fatal("isolated provider unavailable")
		}
		campaign := store.RedTeamCampaign{ID: p.Name, Name: item.name, Scope: "provider", Status: "approved", ExecutionMode: "active-controlled", ApprovedBy: "browser-local-admin", BudgetLimitKRW: 100, ProbePackIDs: []string{pack.ID}, TargetFilter: map[string]any{"target_type": "model", "provider": p.Name, "models": []string{"test-model"}}}
		if err := h.db.UpsertRedTeamCampaign(t.Context(), campaign); err != nil {
			t.Fatal("isolated campaign unavailable")
		}
	}
}

func verifyRedTeamBrowserStorage(t *testing.T, h *browserAuthHarness) {
	t.Helper()
	runs, err := h.db.ListRedTeamRuns(t.Context(), 500)
	history := 0
	for _, run := range runs {
		if run.CampaignID == "browser-history" {
			history++
		}
	}
	if err != nil || len(runs) != 135 || history != 127 {
		t.Fatal("unexpected persisted execution count")
	}
	for _, run := range runs {
		if run.CampaignID == "browser-history" || strings.HasPrefix(run.CampaignID, "browser-redteam-replay") {
			continue
		}
		results, err := h.db.ListRedTeamCaseResults(t.Context(), run.ID)
		if err != nil {
			t.Fatal("persisted case query failed")
		}
		if run.CampaignID == "browser-redteam-recording" {
			if run.Status != "stopped" || len(results) != 0 {
				t.Fatal("unacknowledged case persisted or completed")
			}
			continue
		}
		if len(results) != 1 {
			t.Fatal("acknowledged case missing")
		}
		if _, found, err := h.db.RedTeamEvidenceByResult(t.Context(), results[0].ID); err != nil || !found {
			t.Fatal("acknowledged evidence missing")
		}
		if run.CampaignID == "browser-redteam-redirect" && results[0].Decision != "error" {
			t.Fatal("redirect recorded as model evaluation")
		}
	}
	audits, err := h.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal("execution audit unavailable")
	}
	admissions := 0
	for _, row := range audits {
		if row.Action == "redteam.campaign.run.reviewed" {
			admissions++
		}
	}
	if admissions != 4 {
		t.Fatal("reviewed execution admission audit count mismatch")
	}
}
