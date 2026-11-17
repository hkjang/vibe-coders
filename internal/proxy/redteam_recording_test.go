package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func reviewedRecordingFixture(t *testing.T, handler http.HandlerFunc) (*Server, *store.SQLStore, *sql.DB, store.RedTeamCampaign) {
	t.Helper()
	resetRedTeamEmergencyTest(t)
	db, raw := impactFailureStore(t)
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	s, err := NewServer(testConfig(upstream.URL, "fixture-key"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := store.RedTeamCampaign{ID: "recording", Name: "저장 확인", Scope: "provider", Status: "approved", ExecutionMode: "active-controlled", ProbePackIDs: []string{"pack"}}
	if err := db.UpsertRedTeamCampaign(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	c, _, _ = db.GetRedTeamCampaign(t.Context(), c.ID)
	if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "model:test:test-model", Provider: "test", Model: "test-model", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: true}, []store.RedTeamProbeCase{{ID: "case", PackID: "pack", CaseKey: "recording", InputTemplate: "Public synthetic test", ExpectedPolicy: "refuse", Severity: "low", TargetTypes: []string{"model"}}}); err != nil {
		t.Fatal(err)
	}
	return s, db, raw, c
}

func TestRedTeamReviewedRecordingFailuresStopAndNeverAcknowledgeCompletion(t *testing.T) {
	for _, stage := range []string{"run_start", "run_start_ignored", "result", "evidence", "remediation", "run_finish", "campaign_finish", "baseline", "deleted_run"} {
		t.Run(stage, func(t *testing.T) {
			var calls atomic.Int32
			var raw *sql.DB
			s, db, rawDB, campaign := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if stage == "deleted_run" {
					if _, err := raw.ExecContext(r.Context(), `DELETE FROM redteam_runs`); err != nil {
						t.Error(err)
					}
				}
				if stage == "remediation" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Allowed synthetic action."}}]}`))
				} else {
					redTeamAdmissionReply(w)
				}
			})
			raw = rawDB
			body := reviewedBody()
			body.Models = []string{"test-model", "second-model"}
			body.Limits.MaxCalls = 2
			review := issueReviewed(t, s, campaign, body)
			table, event, wantStage, wantCalls := "", "INSERT", "case_result", int32(1)
			switch stage {
			case "run_start", "run_start_ignored":
				table, wantStage, wantCalls = "redteam_runs", "run_start", 0
			case "result":
				table = "redteam_case_results"
			case "evidence":
				table = "redteam_evidence"
			case "remediation":
				table = "redteam_remediations"
			case "run_finish":
				table, event, wantStage, wantCalls = "redteam_runs", "UPDATE", "finalize", 2
			case "campaign_finish":
				table, event, wantStage, wantCalls = "redteam_campaigns", "UPDATE", "finalize", 2
			case "baseline":
				table, wantStage, wantCalls = "redteam_baselines", "finalize", 2
			}
			if table != "" {
				statements := []string{fmt.Sprintf(`CREATE TRIGGER reject_recording BEFORE %s ON %s BEGIN SELECT RAISE(ABORT, 'synthetic-recording-fault'); END`, event, table)}
				if os.Getenv("TEST_POSTGRES_DSN") != "" {
					statements = []string{`CREATE FUNCTION reject_recording() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-recording-fault'; END $$`, fmt.Sprintf(`CREATE TRIGGER reject_recording BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION reject_recording()`, event, table)}
				}
				if stage == "run_start_ignored" {
					for i, statement := range statements {
						statement = strings.ReplaceAll(statement, "RAISE(ABORT, 'synthetic-recording-fault')", "RAISE(IGNORE)")
						statements[i] = strings.ReplaceAll(statement, "RAISE EXCEPTION 'synthetic-recording-fault'", "RETURN NULL")
					}
				}
				for _, statement := range statements {
					if _, err := raw.ExecContext(t.Context(), statement); err != nil {
						t.Fatal(err)
					}
				}
			}
			w := reviewedRequest(s, campaign, executionBody(review), "operator", true)
			var outcome struct {
				Complete  bool             `json:"complete"`
				Status    string           `json:"status"`
				Stopped   string           `json:"stopped"`
				Recording redTeamRecording `json:"recording"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &outcome); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || outcome.Complete || outcome.Recording.Confirmed || outcome.Recording.Stage != wantStage || outcome.Status != "stopped" || outcome.Stopped != "recording_failed" || calls.Load() != wantCalls {
				t.Fatalf("incorrect recording admission/outcome: status %d, calls %d, outcome %+v", w.Code, calls.Load(), outcome)
			}
			if strings.Contains(w.Body.String(), "synthetic-recording-fault") {
				t.Fatal("database detail leaked")
			}
			if w := reviewedRequest(s, campaign, executionBody(review), "operator", true); w.Code != 409 || calls.Load() != wantCalls {
				t.Fatal("failed execution replayed")
			}
			baselines, err := db.ListRedTeamBaselines(t.Context())
			if err != nil || len(baselines) != 0 {
				t.Fatal("unconfirmed execution advanced baseline")
			}
			results, err := db.ListRedTeamCaseResults(t.Context(), "")
			wantResults := 0
			if wantStage == "finalize" {
				wantResults = 2
			}
			if err != nil || len(results) != wantResults || outcome.Recording.Results != wantResults {
				t.Fatal("partial case bundle or wrong recorded count")
			}
		})
	}
}

func TestRedTeamReviewedRecordingConfirmedOnSuccess(t *testing.T) {
	var calls atomic.Int32
	s, db, _, campaign := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	// A selected pack without applicable cases must not receive a passing baseline.
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "unrelated", Enabled: true}, []store.RedTeamProbeCase{{ID: "other", PackID: "unrelated", CaseKey: "unrelated", InputTemplate: "Public synthetic", TargetTypes: []string{"mcp_tool"}}}); err != nil {
		t.Fatal(err)
	}
	campaign.ProbePackIDs = []string{"pack", "unrelated"}
	review := issueReviewed(t, s, campaign, reviewedBody())
	w := reviewedRequest(s, campaign, executionBody(review), "operator", true)
	var outcome struct {
		Complete  bool             `json:"complete"`
		Recording redTeamRecording `json:"recording"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &outcome); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !outcome.Complete || !outcome.Recording.Confirmed || outcome.Recording.Stage != "" || outcome.Recording.Results != 1 || calls.Load() != 1 {
		t.Fatal("confirmed execution not acknowledged")
	}
	stored, found, err := db.GetRedTeamCampaign(t.Context(), campaign.ID)
	if err != nil || !found || stored.Status != "completed" {
		t.Fatal("campaign did not finalize")
	}
	baselines, err := db.ListRedTeamBaselines(t.Context())
	if err != nil || len(baselines) != 1 || baselines[0].PackID != "pack" {
		t.Fatal("confirmed passing baseline missing")
	}
}
