//go:build linux

package proxy

import (
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// Capture stored historical values before any browser request. Verification uses
// real SQLite state, including a write fault after the one physical model call.
func seedRedTeamBrowserReplay(t *testing.T, h *browserAuthHarness) func() {
	t.Helper()
	targets := []store.RedTeamTarget{}
	for _, id := range []string{"replay", "replay-recording"} {
		provider := "browser-redteam-" + id
		ref := "model:" + provider + ":test-model"
		targets = append(targets, store.RedTeamTarget{ID: redTeamStableID("model", ref), TargetType: "model", TargetRef: ref, Provider: provider, Model: "test-model", Enabled: true, RiskLevel: "low"})
	}
	if err := h.db.SyncRedTeamTargets(t.Context(), targets); err != nil {
		t.Fatal("replay fixture targets unavailable")
	}
	var checks []func()
	for i, id := range []string{"replay", "replay-recording"} {
		run := store.RedTeamRun{ID: "browser-source-" + id, CampaignID: "browser-redteam-" + id, TargetID: targets[i].ID, Mode: "dry-run", Status: "passed", TotalCases: 1}
		result := store.RedTeamCaseResult{ID: "browser-result-" + id, RunID: run.ID, CaseID: "browser-redteam-case", Decision: "pass", Severity: "low", EvidenceHash: "original-public-hash"}
		evidence := store.RedTeamEvidence{ID: "browser-evidence-" + id, ResultID: result.ID, MaskedPrompt: "원본 공개 검사", MaskedResponse: "원본 공개 응답", RawPrompt: "원본 공개 검사", RawResponse: "비공개 브라우저 응답", ExportHash: result.EvidenceHash, HeadersSummary: map[string]any{"provider": run.CampaignID, "model": "test-model"}}
		if err := h.db.InsertRedTeamRun(t.Context(), run); err != nil {
			t.Fatal("source run unavailable")
		}
		if err := h.db.InsertRedTeamCaseResult(t.Context(), result); err != nil {
			t.Fatal("source result unavailable")
		}
		if err := h.db.InsertRedTeamEvidence(t.Context(), evidence); err != nil {
			t.Fatal("source evidence unavailable")
		}
		if err := h.db.UpsertRedTeamBaseline(t.Context(), store.RedTeamBaseline{ID: "browser-baseline-" + id, TargetID: run.TargetID, PackID: "browser-redteam-pack", BaselineScore: 17}); err != nil {
			t.Fatal("source baseline unavailable")
		}
		storedRun, _, _ := h.db.GetRedTeamRun(t.Context(), run.ID)
		storedResult, _, _ := h.db.GetRedTeamCaseResult(t.Context(), result.ID)
		storedEvidence, _, _ := h.db.RedTeamEvidenceByResult(t.Context(), result.ID)
		campaign, _, _ := h.db.GetRedTeamCampaign(t.Context(), run.CampaignID)
		checks = append(checks, func() {
			afterRun, _, _ := h.db.GetRedTeamRun(t.Context(), run.ID)
			afterResult, _, _ := h.db.GetRedTeamCaseResult(t.Context(), result.ID)
			afterEvidence, _, _ := h.db.RedTeamEvidenceByResult(t.Context(), result.ID)
			afterCampaign, _, _ := h.db.GetRedTeamCampaign(t.Context(), run.CampaignID)
			if !reflect.DeepEqual(storedRun, afterRun) || !reflect.DeepEqual(storedResult, afterResult) || !reflect.DeepEqual(storedEvidence, afterEvidence) || !reflect.DeepEqual(campaign, afterCampaign) {
				t.Fatal("replay changed immutable source or campaign")
			}
		})
	}
	beforeBaselines, err := h.db.ListRedTeamBaselines(t.Context())
	if err != nil {
		t.Fatal("original baseline query failed")
	}
	return func() {
		for _, check := range checks {
			check()
		}
		afterBaselines, err := h.db.ListRedTeamBaselines(t.Context())
		if err != nil {
			t.Fatal("baseline query failed")
		}
		for _, before := range beforeBaselines {
			found := false
			for _, after := range afterBaselines {
				if before.ID == after.ID {
					found = reflect.DeepEqual(before, after)
				}
			}
			if !found {
				t.Fatal("single replay changed pack baseline")
			}
		}
		runs, err := h.db.ListRedTeamRuns(t.Context(), 100)
		if err != nil {
			t.Fatal("replay history unavailable")
		}
		replays := 0
		for _, run := range runs {
			if run.SourceResultID == "" {
				continue
			}
			replays++
			if run.ReviewID == "" || !strings.HasPrefix(run.SourceResultID, "browser-result-replay") || strings.HasPrefix(run.ID, "browser-source-") {
				t.Fatal("replay provenance unavailable")
			}
			results, err := h.db.ListRedTeamCaseResults(t.Context(), run.ID)
			if err != nil {
				t.Fatal("replay results unavailable")
			}
			if run.CampaignID == "browser-redteam-replay-recording" {
				if run.Status != "stopped" || len(results) != 0 {
					t.Fatal("failed replay recording marked complete")
				}
				continue
			}
			if run.Status != "passed" || len(results) != 1 {
				t.Fatal("successful replay not recorded")
			}
			evidence, found, err := h.db.RedTeamEvidenceByResult(t.Context(), results[0].ID)
			if err != nil || !found || evidence.RawPrompt != "" || evidence.RawResponse != "" {
				t.Fatal("masked replay evidence not honored")
			}
		}
		if replays != 2 {
			t.Fatal("unexpected replay count")
		}
		audits, err := h.db.ListAdminAudit(t.Context(), 100)
		if err != nil {
			t.Fatal("replay audit unavailable")
		}
		admissions, rawViews := 0, 0
		for _, audit := range audits {
			if audit.Action == "redteam.evidence.raw_view" {
				rawViews++
				if audit.AdminID == "" || !strings.Contains(audit.AfterValue, "browser-result-replay") || strings.Contains(audit.AfterValue, "비공개 브라우저 응답") {
					t.Fatal("raw read audit missing identity or leaked body")
				}
			}
			if audit.Action == "redteam.result.replay.reviewed" {
				admissions++
				if !strings.Contains(audit.AfterValue, "browser-result-replay") || !strings.Contains(audit.AfterValue, "review_id") || !strings.Contains(audit.AfterValue, "run_id") {
					t.Fatal("replay admission provenance missing")
				}
			}
		}
		if rawViews != 1 {
			t.Fatal("explicit raw read audit count mismatch")
		}
		if admissions != 2 {
			t.Fatal("replay admission audit count mismatch")
		}
	}
}
