package store

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sinkRunFixture(id string) ClickHouseSinkRun {
	now := time.Now().UTC()
	return ClickHouseSinkRun{ID: id, Actor: "fixture-admin", WorkerToken: "worker-" + id, Status: "running", ReviewedAt: appRequestFixedTime(now), CreatedAt: appRequestFixedTime(now), UpdatedAt: appRequestFixedTime(now), LeaseUntil: appRequestFixedTime(now.Add(90 * time.Second)), Progress: ClickHouseSinkRunProgress{EstimatedRows: 1, Dimensions: []ClickHouseSinkRunDimension{{Dimension: "model", Since: "2026-11-01", Until: "2026-11-20", EstimatedRows: 1, Status: "queued"}}}}
}
func sinkRunAudit(run ClickHouseSinkRun, phase string) AdminAuditLog {
	return AdminAuditLog{ID: run.ID + "_" + phase, AdminID: run.Actor, Action: "dw.clickhouse.retry." + phase, AfterValue: "fixture reason"}
}
func readSinkRun(t *testing.T, db *SQLStore, id string) ClickHouseSinkRun {
	t.Helper()
	run, found, err := db.ClickHouseSinkRun(t.Context(), id)
	if err != nil || !found {
		t.Fatalf("missing job %s %v", id, err)
	}
	return run
}
func TestClickHouseSinkRunConcurrentAdmissionAndProgressOwnership(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(map[bool]string{true: "same-review", false: "different-reviews"}[same], func(t *testing.T) {
			first, peer := routingPatchStores(t)
			if err := first.RecordClickHouseSinkFailure(t.Context(), "model", "2026-11-01", "fixture"); err != nil {
				t.Fatal(err)
			}
			pending, err := first.ListClickHouseSinkRetries(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			one := sinkRunFixture("one")
			two := one
			if !same {
				two = sinkRunFixture("two")
			}
			start := make(chan struct{})
			type result struct {
				run ClickHouseSinkRun
				ok  bool
				err error
			}
			results := make(chan result, 2)
			for i, db := range []*SQLStore{first, peer} {
				run := []ClickHouseSinkRun{one, two}[i]
				go func() {
					<-start
					ok, err := db.AdmitClickHouseSinkRun(t.Context(), run, pending, sinkRunAudit(run, "requested"))
					results <- result{run, ok, err}
				}()
			}
			close(start)
			wins := 0
			var winner ClickHouseSinkRun
			for range 2 {
				out := <-results
				if out.ok {
					wins++
					winner = out.run
				} else if same && out.err != nil || !same && !errors.Is(out.err, ErrClickHouseSinkRunBusy) {
					t.Fatalf("unexpected competing admission error %v", out.err)
				}
			}
			if wins != 1 {
				t.Fatalf("admitted %d competing workers", wins)
			}
			audits, err := peer.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 1 {
				t.Fatal("duplicate admission audits")
			}
			before := readSinkRun(t, peer, winner.ID)
			if err := peer.UpdateClickHouseSinkRun(t.Context(), winner.ID, "other-worker", nil, time.Now()); !errors.Is(err, ErrClickHouseSinkRunConflict) {
				t.Fatal("another worker acquired job")
			}
			if !reflect.DeepEqual(before, readSinkRun(t, first, winner.ID)) {
				t.Fatal("rejected worker changed job")
			}
			winner.Progress.SentRows = 1
			if err := first.UpdateClickHouseSinkRun(t.Context(), winner.ID, winner.WorkerToken, &winner.Progress, time.Now()); err != nil {
				t.Fatal(err)
			}
			if readSinkRun(t, peer, winner.ID).Progress.SentRows != 1 {
				t.Fatal("another pool did not observe progress")
			}
			winner.Status = "succeeded"
			winner.FinishedAt = appRequestFixedTime(time.Now())
			if err := first.FinishClickHouseSinkRun(t.Context(), winner, sinkRunAudit(winner, "completed")); err != nil {
				t.Fatal(err)
			}
			if err := peer.UpdateClickHouseSinkRun(t.Context(), winner.ID, winner.WorkerToken, nil, time.Now()); !errors.Is(err, ErrClickHouseSinkRunConflict) {
				t.Fatal("terminal job revived")
			}
			if err := peer.FinishClickHouseSinkRun(t.Context(), winner, sinkRunAudit(winner, "completed")); !errors.Is(err, ErrClickHouseSinkRunConflict) {
				t.Fatal("terminal job completed again")
			}
			audits, err = first.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 2 {
				t.Fatal("terminal audit not exactly once")
			}
		})
	}
}
func TestClickHouseSinkRunAdmissionQueueAndLeaseGuards(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-11-01", "fixture"); err != nil {
		t.Fatal(err)
	}
	pending, err := db.ListClickHouseSinkRetries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-11-01", "new generation"); err != nil {
		t.Fatal(err)
	}
	run := sinkRunFixture("changed-queue")
	ok, err := db.AdmitClickHouseSinkRun(ctx, run, pending, sinkRunAudit(run, "requested"))
	if ok || !errors.Is(err, ErrClickHouseSinkReviewConflict) {
		t.Fatal("stale queue review admitted")
	}
	pending, err = db.ListClickHouseSinkRetries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	run = sinkRunFixture("expired-worker")
	run.LeaseUntil = appRequestFixedTime(time.Now().Add(-time.Second))
	if ok, err := db.AdmitClickHouseSinkRun(ctx, run, pending, sinkRunAudit(run, "requested")); !ok || err != nil {
		t.Fatal(err)
	}
	before := readSinkRun(t, db, run.ID)
	if err := db.UpdateClickHouseSinkRun(ctx, run.ID, run.WorkerToken, nil, time.Now()); !errors.Is(err, ErrClickHouseSinkRunConflict) {
		t.Fatal("expired worker revived")
	}
	run.Status = "succeeded"
	run.FinishedAt = appRequestFixedTime(time.Now())
	if err := db.FinishClickHouseSinkRun(ctx, run, sinkRunAudit(run, "completed")); !errors.Is(err, ErrClickHouseSinkRunConflict) {
		t.Fatal("expired worker published success")
	}
	if !reflect.DeepEqual(before, readSinkRun(t, db, run.ID)) {
		t.Fatal("expired job changed")
	}
	next := sinkRunFixture("new-review")
	if ok, err := db.AdmitClickHouseSinkRun(ctx, next, pending, sinkRunAudit(next, "requested")); !ok || err != nil {
		t.Fatal("expired job prevented explicit new review", err)
	}
}
func TestClickHouseSinkRunAuditCommitFailureRollsBack(t *testing.T) {
	for _, phase := range []string{"requested", "completed"} {
		t.Run(phase, func(t *testing.T) {
			db := openAggTestStore(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			ctx := t.Context()
			run := sinkRunFixture("commit-failure")
			if phase == "completed" {
				if ok, err := db.AdmitClickHouseSinkRun(ctx, run, nil, sinkRunAudit(run, "requested")); !ok || err != nil {
					t.Fatal(err)
				}
			}
			before, found, err := db.ClickHouseSinkRun(ctx, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			drop := installChangeSetAuditCommitFailure(t, db)
			if phase == "requested" {
				ok, err := db.AdmitClickHouseSinkRun(ctx, run, nil, sinkRunAudit(run, phase))
				if ok || err == nil {
					t.Fatal("admission survived failed audit COMMIT")
				}
			} else {
				run.Status = "succeeded"
				run.FinishedAt = appRequestFixedTime(time.Now())
				run.Progress.SentRows = 1
				if err := db.FinishClickHouseSinkRun(ctx, run, sinkRunAudit(run, phase)); err == nil {
					t.Fatal("completion survived failed audit COMMIT")
				}
			}
			after, afterFound, err := db.ClickHouseSinkRun(ctx, run.ID)
			if err != nil || found != afterFound || !reflect.DeepEqual(before, after) {
				t.Fatal("failed COMMIT changed durable job")
			}
			audits, err := db.ListAdminAudit(ctx, 10)
			expected := 0
			if phase == "completed" {
				expected = 1
			}
			if err != nil || len(audits) != expected {
				t.Fatal("failed COMMIT retained audit")
			}
			var children int
			if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM review_fk_child`).Scan(&children); err != nil || children != 0 {
				t.Fatal("failed COMMIT leaked trigger changes")
			}
			if _, err := db.db.ExecContext(ctx, drop); err != nil {
				t.Fatal(err)
			}
			if phase == "requested" {
				if ok, err := db.AdmitClickHouseSinkRun(ctx, run, nil, sinkRunAudit(run, phase)); !ok || err != nil {
					t.Fatal("pool not recovered", err)
				}
			} else if err := db.FinishClickHouseSinkRun(ctx, run, sinkRunAudit(run, phase)); err != nil {
				t.Fatal("pool not recovered", err)
			}
		})
	}
}
func TestClickHouseSinkAcknowledgementCommitFailureRecovers(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	ctx := t.Context()
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-11-01", "fixture"); err != nil {
		t.Fatal(err)
	}
	pending, err := db.ClickHouseSinkRetrySnapshot(ctx, "model")
	if err != nil {
		t.Fatal(err)
	}
	// Move the existing deferred-constraint fault from audit insertion to watermark
	// insertion, so the failure occurs in COMMIT, after both state and queue writes.
	drop := installChangeSetAuditCommitFailure(t, db)
	if _, err := db.db.ExecContext(ctx, drop); err != nil {
		t.Fatal(err)
	}
	trigger := `CREATE TRIGGER sink_bad_commit AFTER INSERT ON clickhouse_sink_state BEGIN INSERT INTO review_fk_child VALUES (1); END`
	drop = `DROP TRIGGER sink_bad_commit`
	if db.dialect == "postgres" {
		trigger = `CREATE TRIGGER sink_bad_commit AFTER INSERT ON clickhouse_sink_state FOR EACH ROW EXECUTE FUNCTION review_bad_commit()`
		drop += ` ON clickhouse_sink_state`
	}
	if _, err := db.db.ExecContext(ctx, trigger); err != nil {
		t.Fatal(err)
	}
	if cleared, err := db.CompleteClickHouseSink(ctx, "model", "2026-11-20", 1, pending); cleared || err == nil {
		t.Fatal("failed COMMIT acknowledged retry")
	}
	after, err := db.ClickHouseSinkRetrySnapshot(ctx, "model")
	if err != nil || !reflect.DeepEqual(pending, after) {
		t.Fatal("failed acknowledgement lost queue")
	}
	state, err := db.ListClickHouseSinkState(ctx)
	if err != nil || len(state) != 0 {
		t.Fatal("failed acknowledgement retained watermark")
	}
	if _, err := db.db.ExecContext(ctx, drop); err != nil {
		t.Fatal(err)
	}
	if cleared, err := db.CompleteClickHouseSink(ctx, "model", "2026-11-20", 1, pending); !cleared || err != nil {
		t.Fatal("pool did not recover after COMMIT failure", err)
	}
}
func TestClickHouseSinkIndexesRemainValidAfterMigration(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"idx_analytics_sink_cursor", "idx_text2sql_sink_cursor", "idx_redteam_sink_cursor"} {
		var definition string
		query := `SELECT sql FROM sqlite_master WHERE type='index' AND name=?`
		if db.dialect == "postgres" {
			query = `SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=? AND n.nspname=current_schema() AND i.indisvalid`
		}
		if err := db.db.QueryRowContext(t.Context(), db.bind(query), name).Scan(&definition); err != nil || !strings.Contains(definition, name) {
			t.Fatalf("missing valid source cursor index %s %v", name, err)
		}
	}
}
