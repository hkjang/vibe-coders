package store

import (
	"errors"
	"reflect"
	"testing"
)

func TestChangeSetAuditedCreation(t *testing.T) {
	for _, mode := range []string{"commit", "audit-failure", "missing-audit-id"} {
		t.Run(mode, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			ctx := t.Context()
			audit := AdminAuditLog{ID: "create-audit", Action: "change_set.create", BeforeValue: "draft"}
			if mode == "audit-failure" {
				if err := db.InsertAdminAudit(ctx, audit); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "missing-audit-id" {
				audit.ID = ""
			}
			before, err := db.ListAdminAudit(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			created, createErr := db.CreateChangeSetAudited(ctx, ChangeSet{ID: "draft", Title: "new draft"}, audit)
			stored, found, err := db.GetChangeSet(ctx, "draft")
			audits, auditErr := db.ListAdminAudit(ctx, 10)
			if err != nil || auditErr != nil {
				t.Fatal("creation outcome unavailable")
			}
			if mode != "commit" {
				if createErr == nil || created.ID != "" || found || !reflect.DeepEqual(before, audits) {
					t.Fatal("failed creation persisted data or returned a success snapshot")
				}
				return
			}
			if createErr != nil || !found || !reflect.DeepEqual(created, stored) || created.CreatedAt == "" || created.UpdatedAt != created.CreatedAt || created.Status != "draft" || len(audits) != 1 {
				t.Fatal("creation response does not match atomically persisted draft and audit")
			}
		})
	}
}

func TestChangeSetAuditedDeletion(t *testing.T) {
	for _, mode := range []string{"commit", "stale-status", "stale-revision", "already-deleted", "audit-failure", "missing-audit-id"} {
		t.Run(mode, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			ctx := t.Context()
			if err := db.CreateChangeSet(ctx, ChangeSet{ID: "delete-target", Title: "delete", Status: "pending"}); err != nil {
				t.Fatal(err)
			}
			snapshot, found, err := db.GetChangeSet(ctx, "delete-target")
			if err != nil || !found {
				t.Fatal("deletion snapshot unavailable")
			}
			audit := AdminAuditLog{ID: "delete-audit", Action: "change_set.delete", BeforeValue: snapshot.ID}
			switch mode {
			case "stale-status":
				_, err = db.db.ExecContext(ctx, `UPDATE change_sets SET status = 'approved' WHERE id = 'delete-target'`)
			case "stale-revision":
				_, err = db.db.ExecContext(ctx, `UPDATE change_sets SET updated_at = 'newer', note = 'newer reason' WHERE id = 'delete-target'`)
			case "already-deleted":
				err = db.DeleteChangeSet(ctx, snapshot.ID)
			case "audit-failure":
				err = db.InsertAdminAudit(ctx, audit)
			case "missing-audit-id":
				audit.ID = ""
			}
			if err != nil {
				t.Fatal(err)
			}
			before, beforeFound, err := db.GetChangeSet(ctx, snapshot.ID)
			if err != nil {
				t.Fatal(err)
			}
			beforeAudits, err := db.ListAdminAudit(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			deleteErr := db.DeleteChangeSetAudited(ctx, snapshot, audit)
			after, afterFound, err := db.GetChangeSet(ctx, snapshot.ID)
			audits, auditErr := db.ListAdminAudit(ctx, 10)
			if err != nil || auditErr != nil {
				t.Fatal("deletion outcome unavailable")
			}
			if mode != "commit" {
				if deleteErr == nil || beforeFound != afterFound || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeAudits, audits) {
					t.Fatal("failed deletion changed snapshot or audit")
				}
				if (mode == "stale-status" || mode == "stale-revision" || mode == "already-deleted") && !errors.Is(deleteErr, ErrChangeSetConflict) {
					t.Fatal("stale deletion did not return conflict")
				}
				return
			}
			if deleteErr != nil || afterFound || len(audits) != 1 || audits[0].Action != audit.Action || audits[0].BeforeValue != snapshot.ID {
				t.Fatal("deletion did not atomically persist exactly one audit")
			}
		})
	}
}

func TestChangeSetAuditedDeletionConcurrentReview(t *testing.T) {
	first, second := routingPatchStores(t)
	ctx := t.Context()
	if err := first.CreateChangeSet(ctx, ChangeSet{ID: "delete-review-race", Title: "parallel", Status: "pending"}); err != nil {
		t.Fatal(err)
	}
	snapshot, found, err := first.GetChangeSet(ctx, "delete-review-race")
	if err != nil || !found {
		t.Fatal("parallel snapshot unavailable")
	}
	start := make(chan struct{})
	type outcome struct {
		action string
		err    error
	}
	results := make(chan outcome, 2)
	go func() {
		<-start
		err := first.DeleteChangeSetAudited(ctx, snapshot, AdminAuditLog{
			ID: "parallel-delete-audit", Action: "change_set.delete", BeforeValue: snapshot.ID,
		})
		results <- outcome{"change_set.delete", err}
	}()
	go func() {
		<-start
		next := snapshot
		next.Status, next.Reviewer = "approved", "reviewer"
		_, err := second.TransitionChangeSetAudited(ctx, next, "pending", AdminAuditLog{
			ID: "parallel-review-audit", Action: "change_set.approved", BeforeValue: snapshot.ID,
		})
		results <- outcome{"change_set.approved", err}
	}()
	close(start)
	wins, conflicts, winner := 0, 0, ""
	for range 2 {
		result := <-results
		if result.err == nil {
			wins++
			winner = result.action
		} else if errors.Is(result.err, ErrChangeSetConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected concurrent transaction error")
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal("concurrent review/deletion did not choose exactly one winner")
	}
	current, found, err := first.GetChangeSet(ctx, snapshot.ID)
	if err != nil || found != (winner == "change_set.approved") || found && (current.Status != "approved" || current.Reviewer != "reviewer") {
		t.Fatal("concurrent winner does not match persisted state")
	}
	audits, err := first.ListAdminAudit(ctx, 10)
	if err != nil || len(audits) != 1 || audits[0].Action != winner || audits[0].BeforeValue != snapshot.ID {
		t.Fatal("concurrent winner did not persist exactly one matching audit")
	}
}

func TestChangeSetAuditedCreateDeleteCommitFailure(t *testing.T) {
	for _, action := range []string{"create", "delete"} {
		t.Run(action, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			ctx := t.Context()
			seed := ChangeSet{ID: "commit-failure", Title: "commit fixture", Status: "draft"}
			if action == "delete" {
				if err := db.CreateChangeSet(ctx, seed); err != nil {
					t.Fatal(err)
				}
				var err error
				seed, _, err = db.GetChangeSet(ctx, seed.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			before, err := db.ListChangeSets(ctx)
			if err != nil {
				t.Fatal(err)
			}
			drop := installChangeSetAuditCommitFailure(t, db)
			audit := AdminAuditLog{ID: "commit-failure-audit", Action: "change_set." + action, BeforeValue: seed.ID}
			mutate := func() error {
				if action == "delete" {
					return db.DeleteChangeSetAudited(ctx, seed, audit)
				}
				created, err := db.CreateChangeSetAudited(ctx, seed, audit)
				if err != nil && created.ID != "" {
					t.Error("failed creation returned a success snapshot")
				}
				return err
			}
			if err := mutate(); err == nil {
				t.Fatal("failed COMMIT reported success")
			}
			after, err := db.ListChangeSets(ctx)
			audits, auditErr := db.ListAdminAudit(ctx, 10)
			if err != nil || auditErr != nil || !reflect.DeepEqual(before, after) || len(audits) != 0 {
				t.Fatal("failed COMMIT persisted data or audit")
			}
			var children int
			if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM review_fk_child`).Scan(&children); err != nil || children != 0 {
				t.Fatal("failed COMMIT retained trigger side effects")
			}
			if _, err := db.db.ExecContext(ctx, drop); err != nil {
				t.Fatal(err)
			}
			if err := mutate(); err != nil {
				t.Fatal("connection did not recover for a subsequent valid mutation")
			}
			after, err = db.ListChangeSets(ctx)
			audits, auditErr = db.ListAdminAudit(ctx, 10)
			wantRows := 0
			if action == "create" {
				wantRows = 1
			}
			if err != nil || auditErr != nil || len(after) != wantRows || len(audits) != 1 || audits[0].Action != audit.Action {
				t.Fatal("recovered operation did not commit its state and one audit")
			}
		})
	}
}
