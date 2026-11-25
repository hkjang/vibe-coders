package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func redTeamJobFixture(id string) RedTeamJob {
	now := time.Now().UTC()
	return RedTeamJob{ID: id, CampaignID: "job-campaign", Actor: "job-actor", WorkerToken: "worker-" + id, Status: "running", CreatedAt: appRequestFixedTime(now), UpdatedAt: appRequestFixedTime(now), LeaseUntil: appRequestFixedTime(now.Add(90 * time.Second)), RedTeamJobDefinition: RedTeamJobDefinition{ReviewID: "review-" + id, Kind: "live", Reason: "검토한 작업", PlannedLiveCalls: 1, PlannedCases: 1}, Progress: RedTeamJobProgress{RunIDs: []string{}}}
}
func redTeamJobAudit(job RedTeamJob, phase string) AdminAuditLog {
	return AdminAuditLog{ID: job.ID + "_" + phase, AdminID: job.Actor, Action: "redteam.job." + phase, AfterValue: "public fixture reason"}
}
func seedJobCampaign(t *testing.T, db *SQLStore) {
	t.Helper()
	if err := db.UpsertRedTeamCampaign(t.Context(), RedTeamCampaign{ID: "job-campaign", Name: "작업 검토"}); err != nil {
		t.Fatal(err)
	}
}
func readRedTeamJob(t *testing.T, db *SQLStore, id string) RedTeamJob {
	t.Helper()
	job, found, err := db.RedTeamJob(t.Context(), id)
	if err != nil || !found {
		t.Fatal("missing durable job", err)
	}
	return job
}

func TestRedTeamJobCrossPoolAdmission(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(map[bool]string{true: "same", false: "different"}[same], func(t *testing.T) {
			first, peer := routingPatchStores(t)
			seedJobCampaign(t, first)
			one, two := redTeamJobFixture("one"), redTeamJobFixture("two")
			if same {
				two = one
			}
			type result struct {
				job      RedTeamJob
				admitted bool
				err      error
			}
			start := make(chan struct{})
			results := make(chan result, 2)
			for i, db := range []*SQLStore{first, peer} {
				job := []RedTeamJob{one, two}[i]
				go func() {
					<-start
					ok, err := db.AdmitRedTeamJob(t.Context(), job, redTeamJobAudit(job, "requested"))
					results <- result{job, ok, err}
				}()
			}
			close(start)
			wins := 0
			var winner RedTeamJob
			for range 2 {
				r := <-results
				if r.admitted {
					wins++
					winner = r.job
				} else if (same && r.err != nil) || (!same && !errors.Is(r.err, ErrRedTeamJobBusy)) {
					t.Fatal("unexpected competing outcome", r.err)
				}
			}
			if wins != 1 {
				t.Fatal("multiple workers admitted", wins)
			}
			audits, err := peer.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 1 {
				t.Fatal("admission audit mismatch", err)
			}
			before := readRedTeamJob(t, peer, winner.ID)
			if err := peer.UpdateRedTeamJob(t.Context(), winner.ID, "wrong-worker", nil, time.Now()); !errors.Is(err, ErrRedTeamJobLease) {
				t.Fatal("foreign worker renewed", err)
			}
			if !reflect.DeepEqual(before, readRedTeamJob(t, first, winner.ID)) {
				t.Fatal("foreign worker changed progress")
			}
			winner.Progress = RedTeamJobProgress{RunIDs: []string{"run-one"}, LiveCalls: 1, CompletedCases: 1, CostKRW: 0.1}
			if err := first.UpdateRedTeamJob(t.Context(), winner.ID, winner.WorkerToken, &winner.Progress, time.Now()); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(readRedTeamJob(t, peer, winner.ID).Progress, winner.Progress) {
				t.Fatal("progress invisible across pool")
			}
			winner.Status = "completed"
			winner.FinishedAt = appRequestFixedTime(time.Now())
			winner.Outcome = json.RawMessage(`{"complete":true}`)
			if err := first.FinishRedTeamJob(t.Context(), winner, redTeamJobAudit(winner, "completed")); err != nil {
				t.Fatal(err)
			}
			if err := peer.UpdateRedTeamJob(t.Context(), winner.ID, winner.WorkerToken, nil, time.Now()); !errors.Is(err, ErrRedTeamJobLease) {
				t.Fatal("terminal job revived")
			}
			if ok, err := peer.AdmitRedTeamJob(t.Context(), winner, redTeamJobAudit(winner, "requested")); ok || err != nil {
				t.Fatal("duplicate job dispatched", err)
			}
			audits, err = peer.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 2 {
				t.Fatal("duplicate audit", err)
			}
		})
	}
}

func TestRedTeamJobExpiredLease(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	seedJobCampaign(t, db)
	job := redTeamJobFixture("expired")
	job.LeaseUntil = appRequestFixedTime(time.Now().Add(-time.Second))
	if ok, err := db.AdmitRedTeamJob(t.Context(), job, redTeamJobAudit(job, "requested")); !ok || err != nil {
		t.Fatal(err)
	}
	before := readRedTeamJob(t, db, job.ID)
	if err := db.UpdateRedTeamJob(t.Context(), job.ID, job.WorkerToken, nil, time.Now()); !errors.Is(err, ErrRedTeamJobLease) {
		t.Fatal("expired worker renewed")
	}
	job.Status = "completed"
	job.FinishedAt = appRequestFixedTime(time.Now())
	if err := db.FinishRedTeamJob(t.Context(), job, redTeamJobAudit(job, "completed")); !errors.Is(err, ErrRedTeamJobLease) {
		t.Fatal("expired worker completed")
	}
	if !reflect.DeepEqual(before, readRedTeamJob(t, db, job.ID)) {
		t.Fatal("expired worker changed state")
	}
	next := redTeamJobFixture("explicit-new-review")
	if ok, err := db.AdmitRedTeamJob(t.Context(), next, redTeamJobAudit(next, "requested")); !ok || err != nil {
		t.Fatal("explicit new review blocked", err)
	}
}

func TestRedTeamJobAuditCommitRollback(t *testing.T) {
	for _, phase := range []string{"requested", "completed"} {
		t.Run(phase, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			seedJobCampaign(t, db)
			job := redTeamJobFixture("fault")
			if phase == "completed" {
				if ok, err := db.AdmitRedTeamJob(t.Context(), job, redTeamJobAudit(job, "requested")); !ok || err != nil {
					t.Fatal(err)
				}
			}
			before, found, err := db.RedTeamJob(t.Context(), job.ID)
			if err != nil {
				t.Fatal(err)
			}
			drop := installChangeSetAuditCommitFailure(t, db)
			if phase == "requested" {
				if ok, err := db.AdmitRedTeamJob(t.Context(), job, redTeamJobAudit(job, phase)); ok || err == nil {
					t.Fatal("admitted without confirmed COMMIT")
				}
			} else {
				job.Status = "completed"
				job.FinishedAt = appRequestFixedTime(time.Now())
				if err := db.FinishRedTeamJob(t.Context(), job, redTeamJobAudit(job, phase)); err == nil {
					t.Fatal("completed without confirmed COMMIT")
				}
			}
			after, afterFound, err := db.RedTeamJob(t.Context(), job.ID)
			if err != nil || found != afterFound || !reflect.DeepEqual(before, after) {
				t.Fatal("failed commit changed job", err)
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			want := 0
			if phase == "completed" {
				want = 1
			}
			if err != nil || len(audits) != want {
				t.Fatal("failed commit retained audit")
			}
			if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
				t.Fatal(err)
			}
			if phase == "requested" {
				if ok, err := db.AdmitRedTeamJob(t.Context(), job, redTeamJobAudit(job, phase)); !ok || err != nil {
					t.Fatal("pool did not recover", err)
				}
			} else if err := db.FinishRedTeamJob(t.Context(), job, redTeamJobAudit(job, phase)); err != nil {
				t.Fatal("pool did not recover", err)
			}
		})
	}
}
