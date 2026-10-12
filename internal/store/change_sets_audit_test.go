package store

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"
)

func TestChangeSetAuditedReviewTransaction(t *testing.T) {
	for _, mode := range []string{"commit", "stale-status", "stale-revision", "audit-failure", "missing-audit-id"} {
		t.Run(mode, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			ctx := t.Context()
			seed := ChangeSet{ID: "review-cas", Title: "review", Status: "pending", Note: "original note",
				Items: []ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "45"}},
				Prior: []ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}}}
			if err := db.CreateChangeSet(ctx, seed); err != nil {
				t.Fatal(err)
			}
			next, found, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil || !found {
				t.Fatal("initial snapshot missing")
			}
			next.Status, next.Note, next.Reviewer = "approved", "checked", "reviewer"
			if mode == "stale-status" {
				if _, err := db.db.ExecContext(ctx, `UPDATE change_sets SET status = 'applied' WHERE id = 'review-cas'`); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "stale-revision" {
				if _, err := db.db.ExecContext(ctx, `UPDATE change_sets SET updated_at = 'newer-revision', note = 'newer note' WHERE id = 'review-cas'`); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "audit-failure" {
				// A duplicate audit identity fails at INSERT on SQLite and PostgreSQL.
				if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "review-audit", Action: "fixture.audit"}); err != nil {
					t.Fatal(err)
				}
			}
			before, _, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil {
				t.Fatal(err)
			}
			beforeAudits, err := db.ListAdminAudit(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			audit := AdminAuditLog{ID: "review-audit", AdminID: "reviewer", Action: "change_set.approved", BeforeValue: seed.ID, AfterValue: `{"reason":"checked"}`}
			if mode == "missing-audit-id" {
				audit.ID = ""
			}
			result, updateErr := db.TransitionChangeSetAudited(ctx, next, "pending", audit)
			after, found, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil || !found {
				t.Fatal("committed row unavailable")
			}
			audits, err := db.ListAdminAudit(ctx, 10)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "commit" {
				if updateErr == nil || result.ID != "" || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeAudits, audits) {
					t.Fatal("failed review changed state/audit or returned a success snapshot")
				}
				if (mode == "stale-status" || mode == "stale-revision") && !errors.Is(updateErr, ErrChangeSetConflict) {
					t.Fatal("stale snapshot did not return a conflict")
				}
				return
			}
			if updateErr != nil || !reflect.DeepEqual(result, after) || after.Status != "approved" || after.Reviewer != "reviewer" || after.Note != "checked" {
				t.Fatal("committed review does not match its response")
			}
			if !reflect.DeepEqual(before.Items, after.Items) || !reflect.DeepEqual(before.Prior, after.Prior) || before.AppliedAt != after.AppliedAt || before.CreatedAt != after.CreatedAt {
				t.Fatal("review changed non-review fields")
			}
			if len(audits) != 1 || audits[0].Action != audit.Action || audits[0].AdminID != audit.AdminID || audits[0].BeforeValue != audit.BeforeValue || audits[0].AfterValue != audit.AfterValue {
				t.Fatal("committed review audit missing or duplicated")
			}
		})
	}
}

func TestChangeSetAuditedReviewCommitFailureAndRecovery(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	ctx := t.Context()
	if err := db.CreateChangeSet(ctx, ChangeSet{ID: "review-commit", Title: "commit", Status: "pending"}); err != nil {
		t.Fatal(err)
	}
	before, found, err := db.GetChangeSet(ctx, "review-commit")
	if err != nil || !found {
		t.Fatal("review snapshot missing")
	}
	drop := installChangeSetAuditCommitFailure(t, db)
	next := before
	next.Status, next.Reviewer = "approved", "reviewer"
	audit := AdminAuditLog{ID: "review-commit-audit", AdminID: "reviewer", Action: "change_set.approved"}
	result, err := db.TransitionChangeSetAudited(ctx, next, "pending", audit)
	if err == nil || result.ID != "" {
		t.Fatal("failed COMMIT returned success")
	}
	after, found, err := db.GetChangeSet(ctx, before.ID)
	audits, auditErr := db.ListAdminAudit(ctx, 10)
	if err != nil || !found || !reflect.DeepEqual(before, after) || auditErr != nil || len(audits) != 0 {
		t.Fatal("failed COMMIT retained review or audit")
	}
	var children int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM review_fk_child`).Scan(&children); err != nil || children != 0 {
		t.Fatal("failed COMMIT retained trigger side effect")
	}
	if _, err := db.db.ExecContext(ctx, drop); err != nil {
		t.Fatal(err)
	}
	result, err = db.TransitionChangeSetAudited(ctx, next, "pending", audit)
	if err != nil || result.Status != "approved" {
		t.Fatal("review connection did not recover")
	}
	audits, err = db.ListAdminAudit(ctx, 10)
	if err != nil || len(audits) != 1 {
		t.Fatal("recovered review did not record exactly one audit")
	}
}

// Fail only at COMMIT, after both mutation and audit INSERT have succeeded.
// The deferred constraint works against the real SQLite and PostgreSQL engines.
func installChangeSetAuditCommitFailure(t *testing.T, db *SQLStore) string {
	t.Helper()
	ctx := t.Context()
	statements := []string{
		`CREATE TABLE review_fk_parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE review_fk_child (parent_id INTEGER REFERENCES review_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
	}
	drop := `DROP TRIGGER review_bad_commit`
	if db.dialect == "postgres" {
		statements = append(statements,
			`CREATE FUNCTION review_bad_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO review_fk_child VALUES (1); RETURN NEW; END $$`,
			`CREATE TRIGGER review_bad_commit AFTER INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION review_bad_commit()`)
		drop += ` ON admin_audit_logs`
	} else {
		statements = append([]string{`PRAGMA foreign_keys = ON`}, statements...)
		statements = append(statements, `CREATE TRIGGER review_bad_commit AFTER INSERT ON admin_audit_logs BEGIN INSERT INTO review_fk_child VALUES (1); END`)
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	return drop
}

func TestChangeSetAuditedReviewCancelled(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	if err := db.CreateChangeSet(t.Context(), ChangeSet{ID: "cancelled-review", Title: "cancelled", Status: "pending"}); err != nil {
		t.Fatal(err)
	}
	before, found, err := db.GetChangeSet(t.Context(), "cancelled-review")
	if err != nil || !found {
		t.Fatal("review snapshot missing")
	}
	next := before
	next.Status = "approved"
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result, err := db.TransitionChangeSetAudited(ctx, next, "pending", AdminAuditLog{ID: "cancelled-audit", Action: "change_set.approved"})
	if !errors.Is(err, context.Canceled) || result.ID != "" {
		t.Fatal("cancelled review did not fail closed")
	}
	after, _, err := db.GetChangeSet(t.Context(), before.ID)
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || !reflect.DeepEqual(before, after) || auditErr != nil || len(audits) != 0 {
		t.Fatal("cancelled review changed state or audit")
	}
}

func TestChangeSetAuditedReviewConcurrentPools(t *testing.T) {
	// Existing portable helper opens two independent pools against one isolated
	// SQLite database or PostgreSQL schema, like two gateway processes.
	first, second := routingPatchStores(t)
	ctx := t.Context()
	if err := first.CreateChangeSet(ctx, ChangeSet{ID: "parallel-review", Title: "parallel", Status: "pending"}); err != nil {
		t.Fatal(err)
	}
	snapshot, found, err := first.GetChangeSet(ctx, "parallel-review")
	if err != nil || !found {
		t.Fatal("review snapshot missing")
	}
	start := make(chan struct{})
	type outcome struct {
		result ChangeSet
		err    error
	}
	results := make(chan outcome, 2)
	for index, db := range []*SQLStore{first, second} {
		go func() {
			<-start
			next := snapshot
			actor := "reviewer-" + strconv.Itoa(index)
			next.Status, next.Reviewer, next.Note = "approved", actor, actor
			result, err := db.TransitionChangeSetAudited(ctx, next, "pending", AdminAuditLog{
				ID: "audit-" + actor, AdminID: actor, Action: "change_set.approved", BeforeValue: next.ID,
			})
			results <- outcome{result, err}
		}()
	}
	close(start)
	winner := ChangeSet{}
	wins, conflicts := 0, 0
	for range 2 {
		result := <-results
		if result.err == nil {
			wins++
			winner = result.result
		} else if errors.Is(result.err, ErrChangeSetConflict) && result.result.ID == "" {
			conflicts++
		} else {
			t.Errorf("unexpected competing review result: %v", result.err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("review winners=%d conflicts=%d; want one each", wins, conflicts)
	}
	stored, found, err := second.GetChangeSet(ctx, snapshot.ID)
	if err != nil || !found || !reflect.DeepEqual(stored, winner) {
		t.Fatal("the second pool did not observe the winning review")
	}
	audits, err := second.ListAdminAudit(ctx, 10)
	if err != nil || len(audits) != 1 || audits[0].AdminID != winner.Reviewer {
		t.Fatal("competing reviews did not leave exactly the winning audit")
	}
}
