package store

import (
	"fmt"
	"testing"
)

func recordingStoreFixture(t *testing.T) (*SQLStore, RedTeamRun, RedTeamCaseResult, RedTeamEvidence, RedTeamRemediation) {
	t.Helper()
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	if err := db.UpsertRedTeamCampaign(t.Context(), RedTeamCampaign{ID: "campaign", Name: "공개 기록 검사", Status: "approved"}); err != nil {
		t.Fatal(err)
	}
	run := RedTeamRun{ID: "run", CampaignID: "campaign", TargetID: "target", Status: "running"}
	if err := db.InsertRedTeamRun(t.Context(), run); err != nil {
		t.Fatal(err)
	}
	return db, run, RedTeamCaseResult{ID: "result", RunID: "run", CaseID: "case", Decision: "pass"}, RedTeamEvidence{ID: "evidence", ResultID: "result", MaskedPrompt: "public synthetic"}, RedTeamRemediation{ID: "remediation", ResultID: "result", ActionType: "review", Status: "open"}
}

// Trigger errors at the actual SQL statement boundary, in an isolated test DB.
func poisonRedTeamRecording(t *testing.T, db *SQLStore, table, event string) {
	t.Helper()
	var statements []string
	if db.dialect == "postgres" {
		statements = []string{
			`CREATE FUNCTION reject_recording() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic recording failure'; END $$`,
			fmt.Sprintf(`CREATE TRIGGER reject_recording BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION reject_recording()`, event, table),
		}
	} else {
		statements = []string{fmt.Sprintf(`CREATE TRIGGER reject_recording BEFORE %s ON %s BEGIN SELECT RAISE(ABORT, 'synthetic recording failure'); END`, event, table)}
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRedTeamRecordingBundleRollsBackEveryComponent(t *testing.T) {
	for _, table := range []string{"redteam_case_results", "redteam_evidence", "redteam_remediations"} {
		t.Run(table, func(t *testing.T) {
			db, _, result, evidence, remediation := recordingStoreFixture(t)
			poisonRedTeamRecording(t, db, table, "INSERT")
			if err := db.SaveRedTeamCaseBundle(t.Context(), result, evidence, remediation); err == nil {
				t.Fatal("failed bundle acknowledged")
			}
			for _, name := range []string{"redteam_case_results", "redteam_evidence", "redteam_remediations"} {
				var count int
				if err := db.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM `+name).Scan(&count); err != nil || count != 0 {
					t.Fatalf("partial bundle in %s: %d, %v", name, count, err)
				}
			}
		})
	}
}

func TestRedTeamRecordingBundleNeedsRunningRun(t *testing.T) {
	for _, state := range []string{"missing", "passed", "wrong_evidence"} {
		t.Run(state, func(t *testing.T) {
			db, run, result, evidence, remediation := recordingStoreFixture(t)
			switch state {
			case "missing":
				_, _ = db.db.ExecContext(t.Context(), `DELETE FROM redteam_runs`)
			case "passed":
				run.Status = "passed"
				if err := db.UpdateRedTeamRun(t.Context(), run); err != nil {
					t.Fatal(err)
				}
			case "wrong_evidence":
				evidence.ResultID = "other"
			}
			if err := db.SaveRedTeamCaseBundle(t.Context(), result, evidence, remediation); err == nil {
				t.Fatal("invalid bundle accepted")
			}
		})
	}
}

func TestRedTeamRecordingFinalizationRollback(t *testing.T) {
	for _, stage := range []string{"redteam_runs", "redteam_campaigns", "redteam_baselines", "missing_run", "missing_campaign", "wrong_campaign"} {
		t.Run(stage, func(t *testing.T) {
			db, run, result, evidence, remediation := recordingStoreFixture(t)
			if err := db.SaveRedTeamCaseBundle(t.Context(), result, evidence, remediation); err != nil {
				t.Fatal(err)
			}
			baseline := RedTeamBaseline{ID: "baseline", TargetID: run.TargetID, PackID: "pack", BaselineScore: 7}
			if err := db.UpsertRedTeamBaseline(t.Context(), baseline); err != nil {
				t.Fatal(err)
			}
			baseline.BaselineScore = 0
			switch stage {
			case "missing_run":
				_, _ = db.db.ExecContext(t.Context(), `DELETE FROM redteam_runs`)
			case "missing_campaign":
				_, _ = db.db.ExecContext(t.Context(), `DELETE FROM redteam_campaigns`)
			case "wrong_campaign":
				_, _ = db.db.ExecContext(t.Context(), `UPDATE redteam_runs SET campaign_id = 'other'`)
			case "redteam_baselines":
				poisonRedTeamRecording(t, db, stage, "INSERT")
			default:
				poisonRedTeamRecording(t, db, stage, "UPDATE")
			}
			run.Status, run.TotalCases = "passed", 1
			if err := db.FinalizeRedTeamExecution(t.Context(), "campaign", "completed", "operator", []RedTeamRun{run}, []RedTeamBaseline{baseline}); err == nil {
				t.Fatal("failed finalization acknowledged")
			}
			if stage != "missing_run" {
				stored, found, err := db.GetRedTeamRun(t.Context(), run.ID)
				if err != nil || !found || stored.Status != "running" {
					t.Fatal("partial run finalization")
				}
			}
			if stage != "missing_campaign" {
				stored, found, err := db.GetRedTeamCampaign(t.Context(), "campaign")
				if err != nil || !found || stored.Status != "approved" {
					t.Fatal("partial campaign finalization")
				}
			}
			stored, err := db.ListRedTeamBaselines(t.Context())
			if err != nil || len(stored) != 1 || stored[0].BaselineScore != 7 {
				t.Fatal("baseline advanced despite failed finalization")
			}
		})
	}
}

func TestRedTeamRecordingAcknowledgedRoundTrip(t *testing.T) {
	db, run, result, evidence, remediation := recordingStoreFixture(t)
	if err := db.SaveRedTeamCaseBundle(t.Context(), result, evidence, remediation); err != nil {
		t.Fatal(err)
	}
	run.Status, run.TotalCases = "passed", 1
	if err := db.FinalizeRedTeamExecution(t.Context(), "campaign", "completed", "operator", []RedTeamRun{run}, []RedTeamBaseline{{ID: "baseline", TargetID: "target", PackID: "pack"}}); err != nil {
		t.Fatal(err)
	}
	stored, found, err := db.GetRedTeamRun(t.Context(), run.ID)
	if err != nil || !found || stored.Status != "passed" || stored.TotalCases != 1 {
		t.Fatal("run not finalized")
	}
	if _, found, err := db.RedTeamEvidenceByResult(t.Context(), result.ID); err != nil || !found {
		t.Fatal("evidence missing")
	}
	campaign, found, err := db.GetRedTeamCampaign(t.Context(), "campaign")
	if err != nil || !found || campaign.Status != "completed" {
		t.Fatal("campaign not finalized")
	}
}

func TestRedTeamRecordingIgnoredInsertIsNotAcknowledged(t *testing.T) {
	db, _, result, evidence, remediation := recordingStoreFixture(t)
	statements := []string{`CREATE TRIGGER ignore_evidence BEFORE INSERT ON redteam_evidence BEGIN SELECT RAISE(IGNORE); END`}
	if db.dialect == "postgres" {
		statements = []string{`CREATE FUNCTION ignore_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`, `CREATE TRIGGER ignore_evidence BEFORE INSERT ON redteam_evidence FOR EACH ROW EXECUTE FUNCTION ignore_evidence()`}
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SaveRedTeamCaseBundle(t.Context(), result, evidence, remediation); err == nil {
		t.Fatal("zero affected rows acknowledged")
	}
	rows, err := db.ListRedTeamCaseResults(t.Context(), result.RunID)
	if err != nil || len(rows) != 0 {
		t.Fatal("result without acknowledged evidence committed")
	}
}
