package store

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestPromptStageWorkspaceSnapshotPageAndCounts(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Now().UTC().Truncate(time.Second).Add(-time.Minute)
	for i := range 31 {
		if err := db.SetPromptStage(ctx, PromptPromotion{PromptName: fmt.Sprintf("saved-%02d", i), PromptVersion: "v1", Stage: PromptStageValidation, Note: "private-note", PromotedBy: "private-actor"}); err != nil {
			t.Fatal(err)
		}
	}
	for i, delta := range []time.Duration{-time.Nanosecond, 0, time.Nanosecond, time.Second} {
		id := fmt.Sprintf("observed-%d", i)
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{ID: id, PromptName: "observed", PromptVersion: "v1", StatusCode: 500, CreatedAt: base.Add(delta)}}); err != nil {
			t.Fatal(err)
		}
	}
	// Independent one-to-many records used to multiply calls and each other's sums.
	for i := range 2 {
		if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO token_usage(id,request_id,prompt_tokens,completion_tokens,total_tokens,estimated_cost,currency,source,created_at) VALUES(?, 'observed-1',1,1,2,3,'KRW','fixture',?)`), fmt.Sprintf("use-%d", i), formatTime(base)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO llm_evaluations(id,request_id,trace_id,name,category,evaluator,score,label,passed,created_at) VALUES(?, 'observed-1','','check','quality','fixture',0,'fail',0,?)`), fmt.Sprintf("eval-%d", i), formatTime(base)); err != nil {
			t.Fatal(err)
		}
	}
	rows, total, err := db.PromptStageWorkspacePage(ctx, base, base.Add(time.Second), "all", 25, 0)
	if err != nil || total != 32 || len(rows) != 25 {
		t.Fatalf("page: rows=%d total=%d err=%v", len(rows), total, err)
	}
	first := rows[0]
	if first.Snapshot.Registered || first.Snapshot.Promotion.Stage != PromptStageExperiment || first.Stats.Calls != 2 || first.Stats.Errors != 2 || first.Stats.EvalFailures != 2 {
		t.Fatalf("observed version mismatch: %+v", first)
	}
	rows, total, err = db.PromptStageWorkspacePage(ctx, base, base.Add(time.Second), "all", 25, 25)
	if err != nil || total != 32 || len(rows) != 7 || rows[0].Stats.Calls != 0 || !rows[0].Snapshot.Registered {
		t.Fatal("saved stages without calls missing", err)
	}
	rows, total, err = db.PromptStageWorkspacePage(ctx, base, base.Add(time.Second), "experiment", 25, 0)
	if err != nil || total != 1 || len(rows) != 1 {
		t.Fatal("default stage filter mismatch", err)
	}
	stats, err := db.PromptVersionStatsSince(ctx, base)
	if err != nil || len(stats) != 1 || stats[0].Calls != 3 || stats[0].Errors != 3 || stats[0].EvalFailures != 2 || stats[0].CostKRW != 6 {
		t.Fatalf("legacy stats multiplication: %+v %v", stats, err)
	}
	for _, bounds := range [][2]int{{0, 0}, {101, 0}, {25, -1}, {25, 1000001}} {
		if _, _, err := db.PromptStageWorkspacePage(ctx, base, base.Add(time.Second), "all", bounds[0], bounds[1]); err == nil {
			t.Fatal("accepted invalid page")
		}
	}
}

func TestPromptStageWorkspaceAtomicReview(t *testing.T) {
	for _, mode := range []string{"create", "update", "stale-note", "stale-actor", "stale-stage", "stale-time", "concurrent-create", "audit-failure"} {
		t.Run(mode, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			ctx := t.Context()
			if mode != "create" && mode != "concurrent-create" {
				if err := db.SetPromptStage(ctx, PromptPromotion{PromptName: "p", PromptVersion: "v1", Stage: PromptStageExperiment, Note: "original", PromotedBy: "first"}); err != nil {
					t.Fatal(err)
				}
			}
			expected, err := db.GetPromptStageSnapshot(ctx, "p", "v1")
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "concurrent-create":
				if err := db.SetPromptStage(ctx, PromptPromotion{PromptName: "p", PromptVersion: "v1", Stage: PromptStageProduction}); err != nil {
					t.Fatal(err)
				}
			case "stale-note", "stale-actor", "stale-stage", "stale-time":
				field := map[string]string{"stale-note": "note", "stale-actor": "promoted_by", "stale-stage": "stage", "stale-time": "updated_at"}[mode]
				if _, err := db.db.ExecContext(ctx, `UPDATE prompt_promotions SET `+field+`='new-value'`); err != nil {
					t.Fatal(err)
				}
			case "audit-failure":
				if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "a", Action: "existing"}); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := db.GetPromptStageSnapshot(ctx, "p", "v1")
			auditsBefore, _ := db.ListAdminAudit(ctx, 20)
			changed, err := db.CompareAndSetPromptStage(ctx, expected, PromptStageValidation, "reviewed", AdminAuditLog{ID: "a", Action: "prompt.promotion.set", AdminID: "reviewer"})
			after, readErr := db.GetPromptStageSnapshot(ctx, "p", "v1")
			if readErr != nil {
				t.Fatal(readErr)
			}
			audits, _ := db.ListAdminAudit(ctx, 20)
			if mode == "create" || mode == "update" {
				if err != nil || !after.Registered || after.Promotion.Stage != PromptStageValidation || after.Promotion != changed || len(audits) != 1 || audits[0].AdminID != "reviewer" {
					t.Fatal("stage/audit commit mismatch", err)
				}
			} else {
				if err == nil || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(auditsBefore, audits) || changed.PromptName != "" {
					t.Fatal("failed write changed stage/audit")
				}
				if mode != "audit-failure" && !errors.Is(err, ErrPromptStageConflict) {
					t.Fatal("stale review must conflict", err)
				}
			}
		})
	}
}
func TestPromptStageWorkspaceConcurrentReviews(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	expected, err := db.GetPromptStageSnapshot(ctx, "p", "v1")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := db.CompareAndSetPromptStage(ctx, expected, PromptStageValidation, "reviewed", AdminAuditLog{ID: fmt.Sprintf("race-%d", i), Action: "prompt.promotion.set"})
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrPromptStageConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	audits, err := db.ListAdminAudit(ctx, 20)
	if err != nil || success != 1 || conflict != 1 || len(audits) != 1 {
		t.Fatal("competing creates did not produce one audited commit", err)
	}
}
