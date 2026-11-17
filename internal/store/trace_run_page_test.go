package store

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestTraceRunPageScopePagingAndMetadata(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	if err := db.UpsertWorkflow(t.Context(), Workflow{ID: "wf", Name: "현재 워크플로", Steps: []WorkflowStep{{Type: "chat", Note: "private-definition"}}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for i := range 57 {
		trace, team := "trace-one", "개발팀"
		if i%5 == 0 {
			team = "다른 팀"
		}
		if i == 56 {
			trace = "trace-other"
		}
		id := fmt.Sprintf("run-%03d", i)
		if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: id, WorkflowID: "wf", Team: team, UserID: "owner", TraceID: trace, Status: "ok", CreatedAt: "2026-11-18T00:00:00.1Z", LatencyMS: 50, CostKRW: 2, ErrorClass: "private-error"}); err != nil {
			t.Fatal(err)
		}
		if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: id, AppID: "missing-definition", Team: team, UserID: "owner", TraceID: trace, Status: "error", CreatedAt: "2026-11-18T00:00:00.1Z", LatencyMS: 60, CostKRW: 3, InputHash: "private-hash", OutputSummary: "private-response"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"workflow", "app"} {
		q := TraceRunQuery{TraceID: "trace-one", Kind: kind, Limit: 25, TeamScoped: true, Teams: []string{"開発", "開発 ", "開発"}}
		rows, total, err := db.TraceRunPage(t.Context(), q)
		if err != nil || total != 0 || len(rows) != 0 {
			t.Fatalf("exact scope: total=%d err=%v", total, err)
		}
		q.Teams = []string{"開発 ", "개발팀"}
		seen := map[string]bool{}
		for _, offset := range []int{0, 25, 50} {
			q.Offset = offset
			rows, total, err = db.TraceRunPage(t.Context(), q)
			if err != nil || total != 44 {
				t.Fatalf("total=%d err=%v", total, err)
			}
			for _, row := range rows {
				if seen[row.ID] {
					t.Fatal("duplicate row across pages")
				}
				seen[row.ID] = true
				if row.OwnerID != "owner" {
					t.Fatal(row)
				}
				if kind == "workflow" && row.ResourceName != "현재 워크플로" {
					t.Fatal(row)
				}
			}
		}
		if len(seen) != 44 {
			t.Fatal(len(seen))
		}
		q.Offset = 1000
		rows, total, err = db.TraceRunPage(t.Context(), q)
		if err != nil || total != 44 || len(rows) != 0 {
			t.Fatalf("empty page lost total %d %v", total, err)
		}
		q.TeamScoped = false
		q.Offset = 0
		_, total, err = db.TraceRunPage(t.Context(), q)
		if err != nil || total != 56 {
			t.Fatal(total, err)
		}
	}
}
func TestTraceRunPageBoundsAndNanoseconds(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, kind := range []string{"workflow", "app"} {
		q := TraceRunQuery{TraceID: "trace-nano", Kind: kind, Limit: 1}
		for i, at := range []string{"2026-11-18T00:00:00Z", "2026-11-18T00:00:00.000000001Z", "2026-11-18T00:00:00.1Z"} {
			id := fmt.Sprintf("n-%d", i)
			if kind == "workflow" {
				if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: id, WorkflowID: "none", TraceID: q.TraceID, CreatedAt: at}); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: id, AppID: "none", TraceID: q.TraceID, CreatedAt: at}); err != nil {
					t.Fatal(err)
				}
			}
		}
		for offset := range 3 {
			q.Offset = offset
			rows, total, err := db.TraceRunPage(t.Context(), q)
			if err != nil || total != 3 || len(rows) != 1 || rows[0].ID != fmt.Sprintf("n-%d", 2-offset) {
				t.Fatalf("order=%+v total=%d error=%v", rows, total, err)
			}
		}
	}
	for _, q := range []TraceRunQuery{{Kind: "other", TraceID: "x", Limit: 25}, {Kind: "app", TraceID: "", Limit: 25}, {Kind: "app", TraceID: " x", Limit: 25}, {Kind: "app", TraceID: strings.Repeat("x", 1025), Limit: 25}, {Kind: "app", TraceID: "x", Limit: 101}, {Kind: "app", TraceID: "x", Limit: 25, Offset: -1}} {
		if _, _, err := db.TraceRunPage(t.Context(), q); err != ErrTraceRunQuery {
			t.Fatal("invalid accepted", q, err)
		}
	}
}

func TestTraceRunPageOversizedLegacyUpgrade(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, table := range []string{"workflow_runs", "ai_app_runs"} {
		if _, err := db.db.ExecContext(t.Context(), "DROP INDEX idx_"+table+"_trace_metadata"); err != nil {
			t.Fatal(err)
		}
	}
	huge := strings.Repeat("legacy", 12000)
	if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: "huge", WorkflowID: "none", TraceID: huge}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: "huge", AppID: "none", TraceID: huge}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: "escaped", WorkflowID: "none", TraceID: `C:\legacy\trace`}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: "escaped", AppID: "none", TraceID: `C:\legacy\trace`}); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("repeat migration", err)
	}
	for _, kind := range []string{"workflow", "app"} {
		rows, total, err := db.TraceRunPage(t.Context(), TraceRunQuery{TraceID: "normal", Kind: kind, Limit: 25})
		if err != nil || total != 0 || len(rows) != 0 {
			t.Fatal("oversized legacy record affected normal query", err)
		}
	}
}
func TestTraceRunPageNaturalPlannerAtScale(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") == "" && os.Getenv("TEST_SQLITE_PLANNER") != "1" {
		t.Skip("opt in to natural query plan verification")
	}
	db := openStoreForTest(t)
	defer db.Close()
	tx, err := db.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, table := range []string{"workflow_runs", "ai_app_runs"} {
		resource := "workflow_id"
		if table == "ai_app_runs" {
			resource = "app_id"
		}
		stmt, err := tx.PrepareContext(t.Context(), db.bind("INSERT INTO "+table+"(id,"+resource+",trace_id,team,created_at) VALUES(?,?,?,?,?)"))
		if err != nil {
			t.Fatal(err)
		}
		for i := range 20000 {
			trace := fmt.Sprintf("trace-%d", i)
			if i%200 == 0 {
				trace = "selected-trace"
			}
			if _, err := stmt.ExecContext(t.Context(), fmt.Sprintf("run-%d", i), "none", trace, "team-a", "2026-11-18T00:00:00Z"); err != nil {
				t.Fatal(err)
			}
		}
		stmt.Close()
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(t.Context(), "ANALYZE"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"workflow", "app"} {
		q := TraceRunQuery{TraceID: "selected-trace", Kind: kind, Limit: 25, Teams: []string{"team-a"}, TeamScoped: true}
		statement, args, err := traceRunPageQuery(q, db.dialect)
		if err != nil {
			t.Fatal(err)
		}
		table := "workflow_runs"
		if kind == "app" {
			table = "ai_app_runs"
		}
		index := "idx_" + table + "_trace_metadata"
		if db.dialect == "postgres" {
			_, raw := appFlowNaturalPostgresPlan(t, db, db.bind(renderForDialect(statement, db.dialect)), args...)
			if !strings.Contains(raw, index) {
				t.Fatalf("natural PostgreSQL plan lacks %s: %s", index, raw)
			}
		} else {
			plan := explainAppRequestQuery(t, db, statement, args...)
			if !strings.Contains(plan, index) {
				t.Fatalf("natural SQLite plan lacks %s: %s", index, plan)
			}
		}
		rows, total, err := db.TraceRunPage(t.Context(), q)
		if err != nil || len(rows) != 25 || total != 100 {
			t.Fatal("paged plan result", len(rows), total, err)
		}
	}
}

func TestTraceRunPageLiteralTextBytes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	// These ordinary strings must not be parsed as BYTEA escape input, either by
	// the partial index during inserts or by the bounded metadata projection.
	for i, trace := range []string{`trace\n`, `C:\traces\new`, `\x4142`} {
		id := fmt.Sprintf("run-%d", i)
		name := `C:\work\new\flow`
		if err := db.UpsertWorkflow(t.Context(), Workflow{ID: id, Name: name, Steps: []WorkflowStep{}}); err != nil {
			t.Fatal(err)
		}
		if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: id, WorkflowID: id, TraceID: trace, UserID: `owner\name`, Status: "ok"}); err != nil {
			t.Fatal(err)
		}

		if err := db.CreateWorkApp(t.Context(), WorkApp{ID: id, Title: name, Components: []AppComponent{}}); err != nil {
			t.Fatal(err)
		}
		if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: id, AppID: id, TraceID: trace, UserID: `owner\name`, Status: "ok"}); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"workflow", "app"} {
			rows, total, err := db.TraceRunPage(t.Context(), TraceRunQuery{Kind: kind, TraceID: trace, Limit: 25})
			if err != nil {
				t.Fatal(err)
			}
			if total != 1 || len(rows) != 1 || rows[0].ResourceName != name || rows[0].OwnerID != `owner\name` {
				t.Fatal("literal metadata changed")
			}
		}
	}
}

func TestTraceRunPageLegacyByteaIndexUpgrade(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	if db.dialect != "postgres" {
		t.Skip("PostgreSQL BYTEA index upgrade")
	}
	for _, table := range []string{"workflow_runs", "ai_app_runs"} {
		index := "idx_" + table + "_trace_metadata"
		if _, err := db.db.ExecContext(t.Context(), "DROP INDEX "+index); err != nil {
			t.Fatal(err)
		}
		if _, err := db.db.ExecContext(t.Context(), "CREATE INDEX "+index+" ON "+table+"(trace_id) WHERE length(CAST(trace_id AS BYTEA)) BETWEEN 1 AND 1024"); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := db.Migrate(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	trace := `C:\legacy\trace`
	if err := db.RecordWorkflowRun(t.Context(), WorkflowRun{ID: "legacy", WorkflowID: "none", TraceID: trace}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordAIAppRun(t.Context(), AIAppRun{ID: "legacy", AppID: "none", TraceID: trace}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"workflow", "app"} {
		rows, total, err := db.TraceRunPage(t.Context(), TraceRunQuery{TraceID: trace, Kind: kind, Limit: 25})
		if err != nil || total != 1 || len(rows) != 1 {
			t.Fatal("legacy candidate index was not replaced", err)
		}
	}
}
