package store

import (
	"fmt"
	"testing"
	"time"
)

func TestClickHouseSinkFactBatchCoversTimestampTiesAndBounds(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	start := time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC)
	expected := map[string]bool{}
	for i := 0; i < 1105; i++ {
		id := fmt.Sprintf("fact-%04d", i)
		expected[id] = true
		// Exact seconds and fractional instants have different stored widths.
		at := start
		if i%3 == 1 {
			at = at.Add(500 * time.Millisecond)
		}
		if i%3 == 2 {
			at = at.Add(time.Nanosecond)
		}
		if err := db.InsertText2SQLLog(t.Context(), Text2SQLQueryLog{ID: id, CreatedAt: at, Mode: "execute", Valid: true, Question: "fixture", GeneratedSQL: "SELECT 1"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []Text2SQLQueryLog{{ID: "before", CreatedAt: start.Add(-time.Nanosecond)}, {ID: "after", CreatedAt: start.Add(time.Second)}, {ID: "shadow", CreatedAt: start, Mode: "shadow"}} {
		if err := db.InsertText2SQLLog(t.Context(), row); err != nil {
			t.Fatal(err)
		}
	}
	interval := ClickHouseSinkRange{Dimension: "text2sql_fact", Since: start.Format(time.RFC3339Nano), Until: start.Add(500 * time.Millisecond).Format(time.RFC3339Nano)}
	summary, err := db.SummarizeClickHouseSink(t.Context(), interval)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Rows != 1105 || summary.First != appRequestFixedTime(start) || summary.Last != appRequestFixedTime(start.Add(500*time.Millisecond)) {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	cursor := ClickHouseSinkCursor{}
	seen := map[string]bool{}
	previous := time.Time{}
	for batches := 0; ; batches++ {
		if batches > 40 {
			t.Fatal("cursor did not finish")
		}
		batch, err := db.ReadClickHouseSinkBatch(t.Context(), interval, cursor, 37)
		if err != nil {
			t.Fatal(err)
		}
		if batch.Len() == 0 {
			break
		}
		if len(batch.Text2SQL) > 37 {
			t.Fatal("unbounded batch")
		}
		for _, row := range batch.Text2SQL {
			if !expected[row.ID] || seen[row.ID] {
				t.Fatalf("unexpected or repeated row %q", row.ID)
			}
			if row.CreatedAt.Before(previous) {
				t.Fatal("nonchronological source ordering")
			}
			if !row.Valid || row.Question != "fixture" {
				t.Fatal("source projection changed")
			}
			seen[row.ID] = true
			previous = row.CreatedAt
		}
		cursor = batch.Next
	}
	if len(seen) != len(expected) {
		t.Fatalf("lost source rows: got%d want%d", len(seen), len(expected))
	}
}

func TestClickHouseSinkAcknowledgementKeepsNewerFailureAndEarliestWindow(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-11-01", "first"); err != nil {
		t.Fatal(err)
	}
	old, err := db.ClickHouseSinkRetrySnapshot(ctx, "model")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-11-10", "newer"); err != nil {
		t.Fatal(err)
	}
	current, err := db.ClickHouseSinkRetrySnapshot(ctx, "model")
	if err != nil {
		t.Fatal(err)
	}
	if current.SinceDay != "2026-11-01" || current.Attempts != 2 {
		t.Fatalf("older source window lost: %+v", current)
	}
	cleared, err := db.CompleteClickHouseSink(ctx, "model", "2026-11-20", 20, old)
	if err != nil || cleared {
		t.Fatalf("newer failure cleared=%t err=%v", cleared, err)
	}
	remaining, err := db.ClickHouseSinkRetrySnapshot(ctx, "model")
	if err != nil || remaining == nil || *remaining != *current {
		t.Fatalf("newer work changed: %+v %v", remaining, err)
	}
	cleared, err = db.CompleteClickHouseSink(ctx, "model", "2026-11-19", 30, current)
	if err != nil || !cleared {
		t.Fatalf("current failure not acknowledged: %t %v", cleared, err)
	}
	state, err := db.ListClickHouseSinkState(ctx)
	if err != nil || len(state) != 1 || state[0].LastSyncedDay != "2026-11-20" {
		t.Fatalf("watermark regressed: %+v %v", state, err)
	}
	// An attempt that started with no pending work cannot clear a newly queued failure.
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-10-01", "new window"); err != nil {
		t.Fatal(err)
	}
	if cleared, err := db.CompleteClickHouseSink(ctx, "model", "2026-11-20", 1, nil); err != nil || cleared {
		t.Fatalf("unobserved failure cleared: %t %v", cleared, err)
	}
}

func TestClickHouseSinkNormalizesIntervalsAndRejectsUnknownSources(t *testing.T) {
	for _, r := range []ClickHouseSinkRange{{Dimension: "unknown", Since: "2026-11-01", Until: "2026-11-20"}, {Dimension: "model", Since: "invalid", Until: "2026-11-20"}, {Dimension: "text2sql_fact", Since: "2026-11-21", Until: "2026-11-20"}} {
		if _, err := r.Normalized(); err == nil {
			t.Fatalf("accepted invalid interval: %+v", r)
		}
	}
	r, err := (ClickHouseSinkRange{Dimension: "model", Since: "2026-11-20", Until: "2026-11-20T16:00:00Z"}).Normalized()
	if err != nil || r.Until != "2026-11-21" {
		t.Fatalf("Seoul rollup boundary: %+v %v", r, err)
	}
}

func TestClickHouseSinkRedTeamSummaryMatchesTypedPage(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	if err := db.SyncRedTeamTargets(ctx, []RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "model:fixture", OwnerTeam: "team", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamCampaign(ctx, RedTeamCampaign{ID: "campaign", Name: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamRun(ctx, RedTeamRun{ID: "run", CampaignID: "campaign", TargetID: "target", RiskScore: 42}); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC)
	for i, offset := range []time.Duration{-1, 0, 0, 500 * time.Millisecond, time.Second} {
		if err := db.InsertRedTeamCaseResult(ctx, RedTeamCaseResult{ID: fmt.Sprintf("case-%02d", i), RunID: "run", Decision: "block", Severity: "high", CreatedAt: start.Add(offset).Format(time.RFC3339Nano)}); err != nil {
			t.Fatal(err)
		}
	}
	r := ClickHouseSinkRange{Dimension: "redteam_fact", Since: start.Format(time.RFC3339Nano), Until: start.Add(500 * time.Millisecond).Format(time.RFC3339Nano)}
	summary, err := db.SummarizeClickHouseSink(ctx, r)
	if err != nil || summary.Rows != 3 {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
	cursor := ClickHouseSinkCursor{}
	for i := 1; i <= 3; i++ {
		batch, err := db.ReadClickHouseSinkBatch(ctx, r, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(batch.RedTeam) != 1 || batch.Next.ID != fmt.Sprintf("case-%02d", i) {
			t.Fatalf("page=%+v", batch)
		}
		row := batch.RedTeam[0]
		if row.OwnerTeam != "team" || row.RiskScore != 42 || row.Decision != "block" {
			t.Fatalf("lost target or result metadata: %+v", row)
		}
		cursor = batch.Next
	}
	last, err := db.ReadClickHouseSinkBatch(ctx, r, cursor, 1)
	if err != nil || last.Len() != 0 {
		t.Fatalf("unexpected tail: %+v %v", last, err)
	}
}

func TestClickHouseSinkRetryKeepsEarliestMixedPrecisionBoundary(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	for i, pair := range [][2]string{{"2026-11-20T06:00:00Z", "2026-11-20T06:00:00.500000000Z"}, {"2026-11-20T06:00:00.500000000Z", "2026-11-20T06:00:00Z"}} {
		dim := fmt.Sprintf("fixture_%d", i)
		for _, since := range pair {
			if err := db.RecordClickHouseSinkFailure(t.Context(), dim, since, "fixture"); err != nil {
				t.Fatal(err)
			}
		}
		pending, err := db.ClickHouseSinkRetrySnapshot(t.Context(), dim)
		if err != nil || pending == nil {
			t.Fatal(err)
		}
		at, err := time.Parse(time.RFC3339Nano, pending.SinceDay)
		if err != nil || !at.Equal(time.Date(2026, 11, 20, 6, 0, 0, 0, time.UTC)) {
			t.Fatalf("later fractional boundary replaced earlier work: %s", pending.SinceDay)
		}
	}
}
