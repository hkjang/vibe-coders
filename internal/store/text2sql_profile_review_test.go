package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func profileReviewAudit(id string) AdminAuditLog {
	return AdminAuditLog{ID: id, AdminID: "reviewer", Action: "text2sql.profile.reviewed_upsert", BeforeValue: "before", AfterValue: "after"}
}
func profileForReview(t *testing.T, db *SQLStore, model string) Text2SQLProfile {
	t.Helper()
	p, found, err := db.GetText2SQLProfile(t.Context(), model)
	if err != nil || !found {
		t.Fatal("profile not readable")
	}
	return p
}

func TestText2SQLProfileReviewCreateAndEdit(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	p := Text2SQLProfile{VirtualModel: "vibe/text2sql-reviewed", Mode: "preview", Enabled: true}
	created, err := db.SaveText2SQLProfileReviewed(t.Context(), p, Text2SQLProfileAbsentRevision, profileReviewAudit("create"))
	if err != nil || len(created.Revision) != 64 || created.UpdatedAt == "" || !reflect.DeepEqual(created, profileForReview(t, db, p.VirtualModel)) {
		t.Fatal("reviewed create did not return committed snapshot", err)
	}
	next := created
	next.Mode = "execute"
	next.ExecConnectionID = "analytics"
	next.Enabled = false
	updated, err := db.SaveText2SQLProfileReviewed(t.Context(), next, created.Revision, profileReviewAudit("edit"))
	if err != nil || updated.Revision == created.Revision || !reflect.DeepEqual(updated, profileForReview(t, db, p.VirtualModel)) {
		t.Fatal("reviewed edit did not return committed snapshot", err)
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 2 {
		t.Fatal("create/edit audit missing")
	}
	list, err := db.ListText2SQLProfiles(t.Context())
	if err != nil || len(list) != 1 || list[0].Revision != updated.Revision {
		t.Fatal("list revision differs from detail")
	}
	encoded, _ := json.Marshal(updated)
	if strings.Contains(string(encoded), updated.revisionNonce) || strings.Contains(string(encoded), "revision_nonce") {
		t.Fatal("internal revision nonce leaked")
	}
}

func TestText2SQLProfileReviewRejectsChangedAndRecreated(t *testing.T) {
	for _, change := range []string{"legacy-edit", "legacy-identical", "deleted", "recreated", "old-binary-write", "unchanged", "wrong-id", "cancelled", "audit-failure"} {
		t.Run(change, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			if err := db.UpsertText2SQLProfile(t.Context(), Text2SQLProfile{VirtualModel: "vibe/text2sql-reviewed", Mode: "preview", Enabled: true}); err != nil {
				t.Fatal(err)
			}
			before := profileForReview(t, db, "vibe/text2sql-reviewed")
			next := before
			next.Mode = "execute"
			ctx := t.Context()
			audit := profileReviewAudit("review")
			switch change {
			case "legacy-edit", "legacy-identical":
				current := before
				if change == "legacy-edit" {
					current.ExecConnectionID = "new-owner"
				}
				if err := db.UpsertText2SQLProfile(ctx, current); err != nil {
					t.Fatal(err)
				}
				// Same timestamp/value ABA is still detected through a fresh nonce.
				if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE text2sql_profiles SET updated_at=? WHERE virtual_model=?`), before.UpdatedAt, before.VirtualModel); err != nil {
					t.Fatal(err)
				}
			case "deleted", "recreated":
				if err := db.DeleteText2SQLProfile(ctx, before.VirtualModel); err != nil {
					t.Fatal(err)
				}
				if change == "recreated" {
					if err := db.UpsertText2SQLProfile(ctx, before); err != nil {
						t.Fatal(err)
					}
					if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE text2sql_profiles SET updated_at=? WHERE virtual_model=?`), before.UpdatedAt, before.VirtualModel); err != nil {
						t.Fatal(err)
					}
				}
			case "old-binary-write":
				if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE text2sql_profiles SET upstream_model=? WHERE virtual_model=?`), "changed-by-older-binary", before.VirtualModel); err != nil {
					t.Fatal(err)
				}
			case "unchanged":
				next = before
			case "wrong-id":
				next.VirtualModel = "vibe/text2sql-other"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "audit-failure":
				if err := db.InsertAdminAudit(ctx, audit); err != nil {
					t.Fatal(err)
				}
			}
			current, found, err := db.GetText2SQLProfile(t.Context(), before.VirtualModel)
			if err != nil {
				t.Fatal(err)
			}
			priorAudits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil {
				t.Fatal(err)
			}
			got, saveErr := db.SaveText2SQLProfileReviewed(ctx, next, before.Revision, audit)
			if saveErr == nil || got.VirtualModel != "" {
				t.Fatal("rejected review returned success")
			}
			after, exists, err := db.GetText2SQLProfile(t.Context(), before.VirtualModel)
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil || exists != found || !reflect.DeepEqual(current, after) || !reflect.DeepEqual(priorAudits, audits) {
				t.Fatal("rejected review changed profile or audit")
			}
			if change == "unchanged" && !errors.Is(saveErr, ErrText2SQLProfileUnchanged) {
				t.Fatal("no-op not reported")
			}
			if change != "unchanged" && change != "audit-failure" && change != "cancelled" && !errors.Is(saveErr, ErrText2SQLProfileConflict) {
				t.Fatal("stale review not reported as conflict")
			}
		})
	}
}

func TestText2SQLProfileReviewConcurrentPools(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(strconv.FormatBool(exists), func(t *testing.T) {
			first, second := routingPatchStores(t)
			p := Text2SQLProfile{VirtualModel: "vibe/text2sql-concurrent", Mode: "preview", Enabled: true}
			revision := Text2SQLProfileAbsentRevision
			if exists {
				if err := first.UpsertText2SQLProfile(t.Context(), p); err != nil {
					t.Fatal(err)
				}
				revision = profileForReview(t, first, p.VirtualModel).Revision
			}
			type result struct {
				profile Text2SQLProfile
				err     error
			}
			start := make(chan struct{})
			results := make(chan result, 2)
			for index, db := range []*SQLStore{first, second} {
				go func() {
					<-start
					next := p
					next.UpstreamModel = "candidate-" + strconv.Itoa(index)
					saved, err := db.SaveText2SQLProfileReviewed(t.Context(), next, revision, profileReviewAudit("candidate-"+strconv.Itoa(index)))
					results <- result{saved, err}
				}()
			}
			close(start)
			wins, conflicts := 0, 0
			var winner Text2SQLProfile
			for range 2 {
				got := <-results
				if got.err == nil {
					wins++
					winner = got.profile
				} else if errors.Is(got.err, ErrText2SQLProfileConflict) {
					conflicts++
				} else {
					t.Fatal("unexpected review failure", got.err)
				}
			}
			if wins != 1 || conflicts != 1 || !reflect.DeepEqual(winner, profileForReview(t, second, p.VirtualModel)) {
				t.Fatal("concurrent review must have one winner and one conflict")
			}
			audits, err := second.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 1 {
				t.Fatal("competing reviews must commit only the winning audit")
			}
		})
	}
}

func TestText2SQLProfileReviewCommitFailureRecovery(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	if err := db.UpsertText2SQLProfile(t.Context(), Text2SQLProfile{VirtualModel: "vibe/text2sql-commit", Mode: "preview", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	before := profileForReview(t, db, "vibe/text2sql-commit")
	next := before
	next.Mode = "execute"
	drop := installChangeSetAuditCommitFailure(t, db)
	got, err := db.SaveText2SQLProfileReviewed(t.Context(), next, before.Revision, profileReviewAudit("commit-fail"))
	if err == nil || got.VirtualModel != "" || !reflect.DeepEqual(before, profileForReview(t, db, before.VirtualModel)) {
		t.Fatal("failed COMMIT retained profile or returned success")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("failed COMMIT retained audit")
	}
	var children int
	if err := db.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM review_fk_child`).Scan(&children); err != nil || children != 0 {
		t.Fatal("failed COMMIT retained trigger effects")
	}
	if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
		t.Fatal(err)
	}
	saved, err := db.SaveText2SQLProfileReviewed(t.Context(), next, before.Revision, profileReviewAudit("after-recovery"))
	if err != nil || saved.Mode != "execute" {
		t.Fatal("connection did not recover after failed COMMIT", err)
	}
}

func TestText2SQLProfileReviewMigratesExistingRows(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	p := Text2SQLProfile{VirtualModel: "vibe/text2sql-old-row", Mode: "preview", Enabled: true, ExecConnectionID: "selected"}
	if err := db.UpsertText2SQLProfile(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(t.Context(), `ALTER TABLE text2sql_profiles DROP COLUMN revision_nonce`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	before := profileForReview(t, db, p.VirtualModel)
	if before.revisionNonce != "" || len(before.Revision) != 64 || before.ExecConnectionID != "selected" {
		t.Fatal("old profile not preserved by migration")
	}
	next := before
	next.SummaryModel = "new-summary"
	saved, err := db.SaveText2SQLProfileReviewed(t.Context(), next, before.Revision, profileReviewAudit("migrated"))
	if err != nil || saved.Revision == before.Revision || saved.revisionNonce == "" {
		t.Fatal("migrated row cannot be reviewed", err)
	}
}
