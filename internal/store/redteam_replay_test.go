package store

import (
	"reflect"
	"testing"
)

func TestRedTeamReplayMigrationPreservesExistingRuns(t *testing.T) {
	db, run, _, _, _ := recordingStoreFixture(t)
	for _, index := range []string{"idx_redteam_runs_source_page", "idx_redteam_runs_review"} {
		if _, err := db.db.ExecContext(t.Context(), `DROP INDEX IF EXISTS `+index); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"source_result_id", "review_id"} {
		if _, err := db.db.ExecContext(t.Context(), `ALTER TABLE redteam_runs DROP COLUMN `+column); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := db.Migrate(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	stored, found, err := db.GetRedTeamRun(t.Context(), run.ID)
	if err != nil || !found || stored.SourceResultID != "" || stored.ReviewID != "" || stored.Status != run.Status || stored.CampaignID != run.CampaignID {
		t.Fatal("legacy run changed during upgrade", err)
	}
	replay := RedTeamRun{ID: "replay", CampaignID: run.CampaignID, TargetID: run.TargetID, Status: "running", SourceResultID: "source-result", ReviewID: "source-review"}
	if err := db.InsertRedTeamRun(t.Context(), replay); err != nil {
		t.Fatal(err)
	}
	replay.Status, replay.TotalCases = "passed", 1
	if err := db.FinalizeRedTeamReplay(t.Context(), replay); err != nil {
		t.Fatal(err)
	}
	rows, err := db.ListRedTeamRuns(t.Context(), 10)
	if err != nil || len(rows) != 2 {
		t.Fatal("run history unavailable")
	}
	found = false
	for _, row := range rows {
		if row.ID == replay.ID {
			found = row.SourceResultID == replay.SourceResultID && row.ReviewID == replay.ReviewID && row.Status == "passed"
		}
	}
	if !found {
		t.Fatal("replay provenance lost")
	}
}

func TestRedTeamReplayFinalizationOnlyAcknowledgesMatchingRunningReceipt(t *testing.T) {
	for _, change := range []string{"source", "review", "campaign", "missing", "finished", "too_many_cases", "failure"} {
		t.Run(change, func(t *testing.T) {
			db, original, _, _, _ := recordingStoreFixture(t)
			run := RedTeamRun{ID: "replay", CampaignID: original.CampaignID, TargetID: original.TargetID, Status: "running", SourceResultID: "source", ReviewID: "review"}
			if err := db.InsertRedTeamRun(t.Context(), run); err != nil {
				t.Fatal(err)
			}
			before, _, _ := db.GetRedTeamCampaign(t.Context(), run.CampaignID)
			run.Status, run.TotalCases = "passed", 1
			switch change {
			case "source":
				run.SourceResultID = "other"
			case "review":
				run.ReviewID = "other"
			case "campaign":
				run.CampaignID = "other"
			case "missing":
				run.ID = "absent"
			case "finished":
				if err := db.UpdateRedTeamRun(t.Context(), run); err != nil {
					t.Fatal(err)
				}
			case "too_many_cases":
				run.TotalCases = 2
			case "failure":
				poisonRedTeamRecording(t, db, "redteam_runs", "UPDATE")
			}
			if err := db.FinalizeRedTeamReplay(t.Context(), run); err == nil {
				t.Fatal("invalid replay receipt acknowledged")
			}
			after, _, _ := db.GetRedTeamCampaign(t.Context(), before.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("campaign modified")
			}
		})
	}
}
