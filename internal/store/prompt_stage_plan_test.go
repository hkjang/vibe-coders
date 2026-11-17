package store

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Keep child lookups bounded by request identity, with each engine's natural
// planner. A filter on evaluation status alone would scan retained history.
func TestPromptStageWorkspaceChildPlans(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Second)
	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{ID: "stage-plan-request", PromptName: "plan", PromptVersion: "v1", StatusCode: 200, CreatedAt: now.Add(-time.Second)}}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, query := range []string{
		`INSERT INTO token_usage(id,request_id,prompt_tokens,completion_tokens,total_tokens,estimated_cost,currency,source,created_at) VALUES(?,?,1,1,2,3,'KRW','fixture',?)`,
		`INSERT INTO llm_evaluations(id,request_id,trace_id,name,category,evaluator,score,label,passed,created_at) VALUES(?,?,'','check','quality','fixture',0,'fail',0,?)`,
	} {
		stmt, err := tx.PrepareContext(ctx, db.bind(query))
		if err != nil {
			t.Fatal(err)
		}
		for i := range 8005 {
			request := fmt.Sprintf("retained-%05d", i)
			if i >= 8000 {
				request = "stage-plan-request"
			}
			if _, err := stmt.ExecContext(ctx, fmt.Sprintf("stage-child-%05d", i), request, formatTime(now)); err != nil {
				t.Fatal(err)
			}
		}
		stmt.Close()
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"request_logs", "token_usage", "llm_evaluations"} {
		if _, err := db.db.ExecContext(ctx, "ANALYZE "+table); err != nil {
			t.Fatal(err)
		}
	}
	where, args := metadataTimestampWindowSQL("r.created_at", now.Add(-time.Hour), now)
	query := promptVersionStatsSQL(where)
	plan := ""
	if db.dialect == "postgres" {
		var raw []byte
		if err := db.db.QueryRowContext(ctx, db.bind("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query), args...).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		plan = string(raw)
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
	for _, index := range []string{"idx_llm_evaluations_request_id", "idx_token_usage_request_id"} {
		if !strings.Contains(plan, index) {
			t.Fatal("natural child plan lost request identity index", index)
		}
	}
	rows, err := db.PromptVersionStatsSince(ctx, now.Add(-time.Hour))
	if err != nil || len(rows) != 1 || rows[0].Calls != 1 || rows[0].EvalFailures != 5 || rows[0].CostKRW != 15 {
		t.Fatal("indexed child aggregation differs", err)
	}
	t.Logf("prompt_stage_child_plan dialect=%s retained=8000 selected=5 request_indexes=2", db.dialect)
}
