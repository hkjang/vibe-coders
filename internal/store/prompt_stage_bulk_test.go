package store

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"
)

func seedPromptStageBulk(t *testing.T, db *SQLStore, name string, count int, stamp time.Time) {
	t.Helper()
	for i := range count {
		if err := db.InsertLogRecord(t.Context(), LogRecord{Request: RequestLog{ID: fmt.Sprintf("%s-%d", name, i), PromptName: name, PromptVersion: "v1", StatusCode: 200, CreatedAt: stamp}}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPromptStageBulkSnapshotAndAtomicApply(t *testing.T) {
	for _, mode := range []string{"success", "review-conflict", "second-row-conflict", "duplicate-target", "audit-failure", "invalid-audit"} {
		t.Run(mode, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			ctx := t.Context()
			until := time.Now().UTC()
			since := until.Add(-time.Hour)
			seedPromptStageBulk(t, db, "alpha", 20, since)
			seedPromptStageBulk(t, db, "beta", 50, until.Add(-time.Nanosecond))
			seedPromptStageBulk(t, db, "excluded", 1, until)
			if err := db.SetPromptStage(ctx, PromptPromotion{PromptName: "beta", PromptVersion: "v1", Stage: PromptStageValidation, Note: "old-note", PromotedBy: "old-actor"}); err != nil {
				t.Fatal(err)
			}
			before, err := db.PromptStageBulkSnapshot(ctx, since, until)
			if err != nil || len(before) != 2 || before[0].Stats.Calls != 20 || before[1].Stats.Calls != 50 || before[0].Snapshot.Registered || !before[1].Snapshot.Registered {
				t.Fatal("snapshot mismatch", err)
			}
			if mode == "audit-failure" {
				if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "bulk-audit", Action: "existing"}); err != nil {
					t.Fatal(err)
				}
			}
			auditBefore, _ := db.ListAdminAudit(ctx, 20)
			changed, err := db.ApplyPromptStageBulk(ctx, since, until, "검토 완료", func(rows []PromptStageWorkspaceRow) ([]PromptStageBatchChange, AdminAuditLog, error) {
				if !reflect.DeepEqual(rows, before) {
					t.Fatal("transaction did not read expected snapshot")
				}
				audit := AdminAuditLog{ID: "bulk-audit", Action: "prompt.promotion.auto", AdminID: "reviewer", BeforeValue: "before", AfterValue: "after"}
				if mode == "review-conflict" {
					return nil, audit, ErrPromptStageConflict
				}
				if mode == "invalid-audit" {
					audit.ID = ""
				}
				plan := []PromptStageBatchChange{{rows[0].Snapshot, PromptStageValidation}, {rows[1].Snapshot, PromptStageProduction}}
				if mode == "second-row-conflict" {
					plan[1].Expected.Promotion.Note = "stale"
				}
				if mode == "duplicate-target" {
					plan[1] = plan[0]
				}
				return plan, audit, nil
			})
			after, readErr := db.PromptStageBulkSnapshot(ctx, since, until)
			if readErr != nil {
				t.Fatal(readErr)
			}
			audits, _ := db.ListAdminAudit(ctx, 20)
			if mode != "success" {
				if err == nil || len(changed) != 0 || !reflect.DeepEqual(before, after) || len(audits) != len(auditBefore) {
					t.Fatal("failed batch was partially committed", mode, err)
				}
				return
			}
			if err != nil || len(changed) != 2 || len(audits) != 1 || audits[0].AdminID != "reviewer" || after[0].Snapshot.Promotion.Stage != PromptStageValidation || after[1].Snapshot.Promotion.Stage != PromptStageProduction {
				t.Fatal("commit mismatch", err)
			}
			for _, row := range after {
				if row.Snapshot.Promotion.Note != "검토 완료" || row.Snapshot.Promotion.PromotedBy != "reviewer" {
					t.Fatal("reason or actor missing")
				}
			}
		})
	}
}

func TestPromptStageBulkLimitNeverReturnsPartialPlan(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	now := time.Now().UTC()
	for i := range MaxPromptStageBulkVersions + 1 {
		seedPromptStageBulk(t, db, fmt.Sprintf("bulk-%04d", i), 1, now.Add(-time.Minute))
	}
	rows, err := db.PromptStageBulkSnapshot(t.Context(), now.Add(-time.Hour), now)
	if !errors.Is(err, ErrPromptStageBulkLimit) || rows != nil {
		t.Fatal("oversized observation returned a partial plan", err)
	}
	called := false
	_, err = db.ApplyPromptStageBulk(t.Context(), now.Add(-time.Hour), now, "reason", func([]PromptStageWorkspaceRow) ([]PromptStageBatchChange, AdminAuditLog, error) {
		called = true
		return nil, AdminAuditLog{}, nil
	})
	if called || !errors.Is(err, ErrPromptStageBulkLimit) {
		t.Fatal("oversized observation reached mutation", err)
	}
	audits, _ := db.ListAdminAudit(t.Context(), 20)
	if len(audits) != 0 {
		t.Fatal("oversized plan created audit")
	}
}

func TestPromptStageBulkConcurrentReviewsCommitOnce(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	until := time.Now().UTC()
	since := until.Add(-time.Hour)
	seedPromptStageBulk(t, db, "alpha", 20, since)
	seedPromptStageBulk(t, db, "beta", 20, since)
	expected, err := db.PromptStageBulkSnapshot(t.Context(), since, until)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := db.ApplyPromptStageBulk(t.Context(), since, until, "reviewed", func(rows []PromptStageWorkspaceRow) ([]PromptStageBatchChange, AdminAuditLog, error) {
				if !reflect.DeepEqual(rows, expected) {
					return nil, AdminAuditLog{}, ErrPromptStageConflict
				}
				return []PromptStageBatchChange{{rows[0].Snapshot, PromptStageValidation}, {rows[1].Snapshot, PromptStageValidation}}, AdminAuditLog{ID: fmt.Sprintf("race-%d", i), AdminID: "reviewer", Action: "prompt.promotion.auto"}, nil
			})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || success != 1 || len(audits) != 1 {
		t.Fatal("batch committed more or fewer than once", success, err)
	}
	for _, name := range []string{"alpha", "beta"} {
		row, err := db.GetPromptStageSnapshot(t.Context(), name, "v1")
		if err != nil || row.Promotion.Stage != PromptStageValidation {
			t.Fatal("partial concurrent batch", err)
		}
	}
}
