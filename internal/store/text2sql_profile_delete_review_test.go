package store

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"
)

func profileDeleteAudit(id string) AdminAuditLog {
	audit := profileReviewAudit(id)
	audit.Action = "text2sql.profile.reviewed_delete"
	return audit
}

func TestText2SQLProfileDeleteReviewFailures(t *testing.T) {
	for _, change := range []string{"edited", "identical", "deleted", "recreated", "old-binary", "wrong-id", "cancelled", "audit-failure", "invalid-audit"} {
		t.Run(change, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			model := "vibe/text2sql-reviewed-delete"
			if err := db.UpsertText2SQLProfile(t.Context(), Text2SQLProfile{VirtualModel: model, Mode: "execute", Enabled: true}); err != nil {
				t.Fatal(err)
			}
			before := profileForReview(t, db, model)
			ctx := t.Context()
			audit := profileDeleteAudit("delete-review")
			switch change {
			case "edited", "identical", "recreated":
				if change == "recreated" {
					if err := db.DeleteText2SQLProfile(ctx, model); err != nil {
						t.Fatal(err)
					}
				}
				next := before
				if change == "edited" {
					next.UpstreamModel = "other"
				}
				if err := db.UpsertText2SQLProfile(ctx, next); err != nil {
					t.Fatal(err)
				}
				if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE text2sql_profiles SET updated_at=? WHERE virtual_model=?`), before.UpdatedAt, model); err != nil {
					t.Fatal(err)
				}
			case "deleted":
				if err := db.DeleteText2SQLProfile(ctx, model); err != nil {
					t.Fatal(err)
				}
			case "old-binary":
				if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE text2sql_profiles SET upstream_model=? WHERE virtual_model=?`), "old-change", model); err != nil {
					t.Fatal(err)
				}
			case "wrong-id":
				model = "vibe/text2sql-other"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "audit-failure":
				if err := db.InsertAdminAudit(ctx, audit); err != nil {
					t.Fatal(err)
				}
			case "invalid-audit":
				audit.Action = "text2sql.profile.reviewed_upsert"
			}
			current, found, err := db.GetText2SQLProfile(t.Context(), before.VirtualModel)
			if err != nil {
				t.Fatal(err)
			}
			priorAudit, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil {
				t.Fatal(err)
			}
			deleteErr := db.DeleteText2SQLProfileReviewed(ctx, model, before.Revision, audit)
			if deleteErr == nil {
				t.Fatal("unreviewed deletion succeeded")
			}
			after, exists, err := db.GetText2SQLProfile(t.Context(), before.VirtualModel)
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil || found != exists || !reflect.DeepEqual(current, after) || !reflect.DeepEqual(priorAudit, audits) {
				t.Fatal("failed delete changed profile or audit")
			}
			if change != "cancelled" && change != "audit-failure" && change != "invalid-audit" && !errors.Is(deleteErr, ErrText2SQLProfileConflict) {
				t.Fatal("missing revision conflict")
			}
		})
	}
}

func TestText2SQLProfileDeleteReviewCommitRecovery(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	if err := db.UpsertText2SQLProfile(t.Context(), Text2SQLProfile{VirtualModel: "vibe/text2sql-delete-commit", Mode: "execute", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	before := profileForReview(t, db, "vibe/text2sql-delete-commit")
	drop := installChangeSetAuditCommitFailure(t, db)
	if err := db.DeleteText2SQLProfileReviewed(t.Context(), before.VirtualModel, before.Revision, profileDeleteAudit("delete-fail")); err == nil {
		t.Fatal("commit failure returned success")
	}
	if !reflect.DeepEqual(before, profileForReview(t, db, before.VirtualModel)) {
		t.Fatal("failed commit deleted profile")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("failed commit retained audit")
	}
	if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteText2SQLProfileReviewed(t.Context(), before.VirtualModel, before.Revision, profileDeleteAudit("delete-recovered")); err != nil {
		t.Fatal("connection did not recover", err)
	}
	_, found, err := db.GetText2SQLProfile(t.Context(), before.VirtualModel)
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || found || len(audits) != 1 || audits[0].Action != "text2sql.profile.reviewed_delete" {
		t.Fatal("delete and audit not committed together")
	}
}

func TestText2SQLProfileDeleteReviewConcurrentPools(t *testing.T) {
	for _, competingEdit := range []bool{false, true} {
		t.Run(strconv.FormatBool(competingEdit), func(t *testing.T) {
			first, second := routingPatchStores(t)
			p := Text2SQLProfile{VirtualModel: "vibe/text2sql-delete-race", Mode: "preview", Enabled: true}
			if err := first.UpsertText2SQLProfile(t.Context(), p); err != nil {
				t.Fatal(err)
			}
			before := profileForReview(t, first, p.VirtualModel)
			start := make(chan struct{})
			type outcome struct {
				index int
				err   error
			}
			results := make(chan outcome, 2)
			for index, db := range []*SQLStore{first, second} {
				go func() {
					<-start
					var err error
					if competingEdit && index == 1 {
						next := before
						next.Mode = "execute"
						_, err = db.SaveText2SQLProfileReviewed(t.Context(), next, before.Revision, profileReviewAudit("edit-winner"))
					} else {
						err = db.DeleteText2SQLProfileReviewed(t.Context(), p.VirtualModel, before.Revision, profileDeleteAudit("delete-"+strconv.Itoa(index)))
					}
					results <- outcome{index, err}
				}()
			}
			close(start)
			winner, wins, conflicts := -1, 0, 0
			for range 2 {
				result := <-results
				if result.err == nil {
					wins++
					winner = result.index
				} else if errors.Is(result.err, ErrText2SQLProfileConflict) {
					conflicts++
				} else {
					t.Fatal(result.err)
				}
			}
			if wins != 1 || conflicts != 1 {
				t.Fatal("one winner and one conflict required")
			}
			after, found, err := second.GetText2SQLProfile(t.Context(), p.VirtualModel)
			if err != nil || found != (competingEdit && winner == 1) || (found && after.Mode != "execute") {
				t.Fatal("stored result differs from winner")
			}
			audits, err := second.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 1 {
				t.Fatal("losing action added audit")
			}
		})
	}
}
