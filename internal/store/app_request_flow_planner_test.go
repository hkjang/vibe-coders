package store

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// The natural planner runs are explicit opt-ins because each builds 200k
// parent, tool and Text2SQL rows. They exercise production migrations/indexes,
// not a hand-built performance schema, and never disable scan strategies.
func TestAppRequestFlowNaturalPlannerAtScale(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") == "" && os.Getenv("TEST_SQLITE_PLANNER") != "1" {
		t.Skip("set TEST_SQLITE_PLANNER=1 or an isolated TEST_POSTGRES_DSN for natural flow query plans")
	}
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	appFlowPopulatePlanner(t, db)
	at := time.Date(2026, 10, 1, 0, 0, 0, 123456789, time.UTC)
	root := AppRequestFlowScope{RequestID: "flow-request-000000199999", CreatedAt: at, Teams: []string{"scope-a"}, TeamScoped: true}
	for _, test := range []struct {
		name  string
		at    time.Time
		scope AppRequestFlowScope
	}{
		{name: "tied timestamp and skewed children", at: at, scope: root},
		{name: "single timestamp and sparse children", at: at.Add(100000*time.Second - 123456789*time.Nanosecond), scope: AppRequestFlowScope{RequestID: "flow-request-000000100000", CreatedAt: at.Add(100000*time.Second - 123456789*time.Nanosecond)}},
		{name: "absent timestamp and request", at: at.Add(-time.Hour), scope: AppRequestFlowScope{RequestID: "missing-request", CreatedAt: at}},
		{name: "team not allowed", at: at, scope: AppRequestFlowScope{RequestID: root.RequestID, CreatedAt: at, Teams: []string{"missing-team"}, TeamScoped: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate, candidateArgs := db.appRequestFlowCandidatesQuery(test.at)
			metadata, metadataArgs := db.appRequestFlowRootQuery(test.scope)
			tools, toolArgs := db.appRequestFlowToolsQuery(test.scope)
			spans, spanArgs := db.appRequestFlowText2SQLQuery(test.scope)
			for _, query := range []struct {
				name, sql, relation, index string
				args                       []any
				cap                        int
			}{
				{"candidates", candidate, "request_logs", "idx_request_logs_app_valid_cursor", candidateArgs, 201},
				{"root", metadata, "request_logs", "", metadataArgs, 1},
				{"tools", tools, "tool_invocations", "idx_tool_invocations_request_id", toolArgs, 101},
				{"text2sql", spans, "text2sql_spans", "idx_text2sql_spans_request_id", spanArgs, 101},
			} {
				t.Run(query.name, func(t *testing.T) {
					if db.dialect == "postgres" {
						plan, raw := appFlowNaturalPostgresPlan(t, db, query.sql, query.args...)
						appFlowAssertPostgresPlan(t, &plan, raw, query.relation, query.index, query.cap)
					} else {
						plan := explainAppRequestQuery(t, db, query.sql, query.args...)
						if query.index != "" && !strings.Contains(plan, query.index) {
							t.Fatalf("natural SQLite plan lacks %s:\n%s", query.index, plan)
						}
						for _, forbidden := range []string{"SCAN r", "SCAN t", "USE TEMP B-TREE"} {
							if strings.Contains(plan, forbidden) {
								t.Fatalf("SQLite flow query has unbounded scan/sort:\n%s", plan)
							}
						}
						t.Logf("natural SQLite path: %s", strings.ReplaceAll(plan, "\n", " | "))
					}
				})
			}
		})
	}
	ids, more, err := db.AppRequestFlowCandidates(t.Context(), at)
	if err != nil || len(ids) != AppRequestFlowCandidateLimit || !more {
		t.Fatal("large tied candidate result was not bounded")
	}
	tools, more, err := db.AppRequestFlowTools(t.Context(), root)
	if err != nil || len(tools) != AppRequestFlowChildLimit || !more {
		t.Fatalf("large nonmatching tool result was not bounded: %v", err)
	}
	for _, tool := range tools {
		if tool.Source != "declaration" {
			t.Fatal("nonmatching tool candidates were refilled to a later call")
		}
	}
	spans, more, err := db.AppRequestFlowText2SQL(t.Context(), root)
	if err != nil || len(spans) != AppRequestFlowChildLimit || !more {
		t.Fatal("large invalid-stage result was not bounded")
	}
}

func appFlowPopulatePlanner(t *testing.T, db *SQLStore) {
	t.Helper()
	const total = 200000
	series := fmt.Sprintf("WITH RECURSIVE n(g) AS (VALUES(1) UNION ALL SELECT g+1 FROM n WHERE g<%d) ", total)
	number := "printf('%012d', g)"
	stamp := "strftime('%Y-%m-%dT%H:%M:%S', '2026-10-01 00:00:00', printf('+%d seconds', g)) || '.000000000Z'"
	if db.dialect == "postgres" {
		series = fmt.Sprintf("WITH n AS (SELECT generate_series(1,%d) AS g) ", total)
		number = "lpad(g::text,12,'0')"
		stamp = `to_char(timestamptz '2026-10-01 00:00:00+00' + g * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000000000Z'`
	}
	appFlowExec(t, db, `INSERT INTO api_keys(id,name,key_hash,team,status,created_at) VALUES ('planner-a','planner','planner-hash','scope-a','active','2026-10-01T00:00:00Z')`)
	appFlowExec(t, db, `INSERT INTO api_keys(id,name,key_hash,team,status,created_at) VALUES ('planner-b','other','other-hash','scope-b','active','2026-10-01T00:00:00Z')`)
	appFlowExec(t, db, series+`INSERT INTO request_logs
		(id,trace_id,api_key_id,endpoint,stream,status_code,latency_ms,first_chunk_ms,created_at)
		SELECT 'flow-request-' || `+number+`, 'flow-trace',
		CASE WHEN g=199999 THEN 'planner-a' ELSE 'planner-b' END,
		'/v1/chat/completions',0,200,10,1,
		CASE WHEN g>199000 THEN '2026-10-01T00:00:00.123456789Z' ELSE `+stamp+` END FROM n`)
	// Skewed children live near the end of physical insertion order. A planner
	// choosing a sequential scan for LIMIT cannot get a cheap accidental pass
	// from matching rows at the beginning of the table.
	request := "CASE WHEN g>180000 THEN 'flow-request-000000199999' ELSE 'flow-request-' || " + number + " END"
	appFlowExec(t, db, series+`INSERT INTO tool_invocations
		(id,request_id,trace_id,tool_name,source,is_mcp,is_error,created_at)
		SELECT 'flow-tool-' || `+number+`, `+request+`, 'flow-trace','tool',
		CASE WHEN g=200000 THEN 'call' ELSE 'declaration' END,0,0,`+stamp+` FROM n`)
	appFlowExec(t, db, series+`INSERT INTO text2sql_spans
		(id,request_id,text2sql_log_id,stage,status,latency_ms,created_at)
		SELECT 'flow-sql-' || `+number+`, `+request+`, 'flow-log','invalid-stage','unknown',0,`+stamp+` FROM n`)
	for _, relation := range []string{"request_logs", "tool_invocations", "text2sql_spans", "api_keys"} {
		appFlowExec(t, db, "ANALYZE "+relation)
	}
}

type appFlowPlanNode struct {
	NodeType            string            `json:"Node Type"`
	RelationName        string            `json:"Relation Name"`
	IndexName           string            `json:"Index Name"`
	ActualRows          float64           `json:"Actual Rows"`
	ActualLoops         float64           `json:"Actual Loops"`
	RowsRemovedByFilter float64           `json:"Rows Removed by Filter"`
	RowsRemovedByCheck  float64           `json:"Rows Removed by Index Recheck"`
	SharedHitBlocks     float64           `json:"Shared Hit Blocks"`
	SharedReadBlocks    float64           `json:"Shared Read Blocks"`
	Plans               []appFlowPlanNode `json:"Plans"`
}

func appFlowNaturalPostgresPlan(t *testing.T, db *SQLStore, query string, args ...any) (appFlowPlanNode, string) {
	t.Helper()
	var raw []byte
	if err := db.db.QueryRowContext(t.Context(), "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON) "+query, args...).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var docs []struct {
		Plan appFlowPlanNode `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &docs); err != nil || len(docs) != 1 {
		t.Fatal("invalid natural flow plan document")
	}
	return docs[0].Plan, string(raw)
}

func appFlowAssertPostgresPlan(t *testing.T, root *appFlowPlanNode, raw, relation, index string, cap int) {
	t.Helper()
	foundRelation, foundIndex := false, index == ""
	var visit func(*appFlowPlanNode)
	visit = func(node *appFlowPlanNode) {
		if node.IndexName == index {
			foundIndex = true
		}
		if node.RelationName == relation {
			foundRelation = true
			visits := (node.ActualRows + node.RowsRemovedByFilter + node.RowsRemovedByCheck) * node.ActualLoops
			if visits > float64(cap) || node.SharedHitBlocks+node.SharedReadBlocks > float64(8*cap+32) {
				t.Fatalf("natural flow lookup exceeded candidate work budget: rows=%.0f blocks=%.0f\n%s", visits, node.SharedHitBlocks+node.SharedReadBlocks, raw)
			}
			if node.NodeType == "Seq Scan" || node.NodeType == "Bitmap Heap Scan" || node.NodeType == "Parallel Seq Scan" {
				t.Fatalf("natural flow query did not seek existing index:\n%s", raw)
			}
			t.Logf("natural PostgreSQL path: relation=%s index=%s type=%s rows=%.0f loops=%.0f removed=%.0f blocks=%.0f cap=%d", relation, node.IndexName, node.NodeType, node.ActualRows, node.ActualLoops, node.RowsRemovedByFilter+node.RowsRemovedByCheck, node.SharedHitBlocks+node.SharedReadBlocks, cap)
		}
		if node.NodeType == "Sort" || node.NodeType == "Incremental Sort" || node.NodeType == "Bitmap Index Scan" {
			t.Fatalf("natural flow query sorted/materialized before the bound:\n%s", raw)
		}
		for i := range node.Plans {
			visit(&node.Plans[i])
		}
	}
	visit(root)
	if !foundRelation || !foundIndex {
		t.Fatalf("natural flow query lacks relation/index path:\n%s", raw)
	}
}
