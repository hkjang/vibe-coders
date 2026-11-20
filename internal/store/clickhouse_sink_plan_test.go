package store

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Keep a narrow retry window bounded among retained history on each engine's
// natural planner, without index hints or disabling sequential scans.
func TestClickHouseSinkNaturalSourceWindowPlans(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	now := time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)
	if err := db.SyncRedTeamTargets(ctx, []RedTeamTarget{{ID: "sink-plan-target", TargetType: "model", TargetRef: "fixture", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamCampaign(ctx, RedTeamCampaign{ID: "sink-plan-campaign", Name: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamRun(ctx, RedTeamRun{ID: "sink-plan-run", CampaignID: "sink-plan-campaign", TargetID: "sink-plan-target"}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	queries := []string{
		`INSERT INTO analytics_daily(day,dimension,dim_value,requests) VALUES (?,'model',?,1)`,
		`INSERT INTO text2sql_query_logs(created_at,id,mode) VALUES (?,?,'execute')`,
		`INSERT INTO redteam_case_results(created_at,id,run_id,case_id,decision,severity) VALUES (?,?,'sink-plan-run','','allow','low')`,
	}
	for index, query := range queries {
		stmt, err := tx.PrepareContext(ctx, db.bind(query))
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 8005; i++ {
			at := now.Add(-365 * 24 * time.Hour).Add(time.Duration(i) * time.Minute)
			if i >= 8000 {
				at = now.Add(-time.Minute).Add(time.Duration(i-8000) * time.Nanosecond)
			}
			value := at.Format(time.RFC3339Nano)
			if index == 0 {
				value = at.Format("2006-01-02")
			}
			if _, err := stmt.ExecContext(ctx, value, fmt.Sprintf("sink-plan-%05d", i)); err != nil {
				t.Fatal(err)
			}
		}
		stmt.Close()
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"analytics_daily", "text2sql_query_logs", "redteam_case_results", "redteam_runs", "redteam_targets"} {
		if _, err := db.db.ExecContext(ctx, "ANALYZE "+table); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []struct{ dimension, index, table string }{{"model", "idx_analytics_sink_cursor", "analytics_daily"}, {"text2sql_fact", "idx_text2sql_sink_cursor", "text2sql_query_logs"}, {"redteam_fact", "idx_redteam_sink_cursor", "redteam_case_results"}} {
		interval := ClickHouseSinkRange{Dimension: source.dimension, Since: now.Add(-time.Hour).Format(time.RFC3339Nano), Until: now.Format(time.RFC3339Nano)}
		from, where, at, _, args, err := sinkSource(interval)
		if err != nil {
			t.Fatal(err)
		}
		pageQuery, pageArgs, err := clickHouseSinkBatchQuery(interval, ClickHouseSinkCursor{}, 1000)
		if err != nil {
			t.Fatal(err)
		}
		deep := ClickHouseSinkRange{Dimension: source.dimension, Since: now.Add(-366 * 24 * time.Hour).Format(time.RFC3339Nano), Until: now.Format(time.RFC3339Nano)}
		lastOld := now.Add(-365 * 24 * time.Hour).Add(7999 * time.Minute)
		position := appRequestFixedTime(lastOld)
		if source.dimension == "model" {
			position = lastOld.Format("2006-01-02")
		}
		deepCursor := ClickHouseSinkCursor{Position: position, ID: "sink-plan-07999"}
		deepQuery, deepArgs, err := clickHouseSinkBatchQuery(deep, deepCursor, 1000)
		if err != nil {
			t.Fatal(err)
		}
		queries := []struct {
			sql   string
			args  []any
			label string
		}{
			{"SELECT COUNT(*),MIN(" + at + "),MAX(" + at + ") FROM " + from + " WHERE " + where, args, "count"},
			{pageQuery, pageArgs, "first-page"},
			{deepQuery, deepArgs, "after-8000-processed"},
		}
		for _, planned := range queries {
			query, args := planned.sql, planned.args
			plan := ""
			if db.dialect == "postgres" {
				root, raw := appFlowNaturalPostgresPlan(t, db, db.bind(query), args...)
				plan = raw
				found := false
				var inspect func(appFlowPlanNode)
				inspect = func(node appFlowPlanNode) {
					if node.RelationName == source.table {
						found = true
						visits := (node.ActualRows + node.RowsRemovedByFilter + node.RowsRemovedByCheck) * node.ActualLoops
						if node.NodeType == "Seq Scan" || node.NodeType == "Parallel Seq Scan" || visits > 5 || node.SharedHitBlocks+node.SharedReadBlocks > 72 {
							t.Fatalf("source window scanned outside its bounded candidates: %s", plan)
						}
						t.Logf("source scan dimension=%s page=%s type=%s index=%s visited=%.0f", source.dimension, planned.label, node.NodeType, node.IndexName, visits)
					}
					for _, child := range node.Plans {
						inspect(child)
					}
				}
				inspect(root)
				if !found {
					t.Fatal("source relation absent from plan")
				}
			} else {
				rows, err := db.db.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query, args...)
				if err != nil {
					t.Fatal(err)
				}
				for rows.Next() {
					var id, parent, unused int
					var detail string
					if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
						t.Fatal(err)
					}
					plan += detail + "\n"
				}
				err = rows.Err()
				rows.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			// PostgreSQL may prefer its smaller existing day index when every
			// row in that day belongs to this dimension. Assert bounded actual
			// work above instead of requiring one particular equivalent index.
			if db.dialect != "postgres" && (!strings.Contains(plan, source.index) || !strings.Contains(plan, "SEARCH r")) {
				t.Fatalf("%s source lost indexed window: %s", source.dimension, plan)
			}
			t.Logf("sink_window_plan dialect=%s dimension=%s retained=8000 selected=5", db.dialect, source.dimension)
		}
		deepPage, err := db.ReadClickHouseSinkBatch(ctx, deep, deepCursor, 1000)
		if err != nil || deepPage.Len() != 5 {
			t.Fatal("deep cursor lost remaining source rows", err)
		}
		summary, err := db.SummarizeClickHouseSink(ctx, interval)
		if err != nil || summary.Rows != 5 {
			t.Fatal("indexed summary differs from selected source", err)
		}
		page, err := db.ReadClickHouseSinkBatch(ctx, interval, ClickHouseSinkCursor{}, 3)
		if err != nil || page.Len() != 3 {
			t.Fatal("bounded first page differs", err)
		}
		tail, err := db.ReadClickHouseSinkBatch(ctx, interval, page.Next, 3)
		if err != nil || tail.Len() != 2 {
			t.Fatal("bounded continuation differs", err)
		}
	}
}
