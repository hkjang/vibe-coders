package store

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRecentRequestsPreciseRangeMatchesApp(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	rows := []struct {
		id    string
		delta time.Duration
	}{
		{"before", -time.Nanosecond}, {"exact", 0}, {"nano", time.Nanosecond},
		{"tenth", 100 * time.Millisecond}, {"half-a", 500 * time.Millisecond}, {"half-z", 500 * time.Millisecond},
		{"next", time.Second}, {"day-end", 24*time.Hour - time.Nanosecond}, {"day-next", 24 * time.Hour},
	}
	stored := map[string]string{}
	for _, item := range rows {
		at := base.Add(item.delta)
		stored[item.id] = at.Format(time.RFC3339Nano)
		err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{ID: item.id, TraceID: "trace-" + item.id, Endpoint: "/v1/chat/completions", Model: "public-model", ClientIP: "192.0.2.78", StatusCode: 200, CreatedAt: at}})
		if err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name     string
		from, to time.Time
		limit    int
		want     []string
	}{
		{"chronological", time.Time{}, time.Time{}, 200, []string{"day-next", "day-end", "next", "half-z", "half-a", "tenth", "nano", "exact", "before"}},
		{"exact lower", base, base.Add(time.Second), 200, []string{"next", "half-z", "half-a", "tenth", "nano", "exact"}},
		{"exact upper", time.Time{}, base, 200, []string{"exact", "before"}},
		{"nano equality", base.Add(time.Nanosecond), base.Add(time.Nanosecond), 200, []string{"nano"}},
		{"fraction upper", base.Add(time.Nanosecond), base.Add(100 * time.Millisecond), 200, []string{"tenth", "nano"}},
		{"inclusive date end", base, base.Add(24*time.Hour - time.Nanosecond), 200, []string{"day-end", "next", "half-z", "half-a", "tenth", "nano", "exact"}},
		{"latest limited", base, base.Add(500 * time.Millisecond), 2, []string{"half-z", "half-a"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			legacy, err := db.RecentRequests(ctx, RequestFilter{From: tc.from, To: tc.to, Limit: tc.limit, Model: "public-model", IP: "192.0.2.78"})
			if err != nil {
				t.Fatal(err)
			}
			ids := []string{}
			for _, row := range legacy {
				ids = append(ids, row.ID)
				if row.CreatedAt != stored[row.ID] {
					t.Fatalf("response timestamp changed: %q want %q", row.CreatedAt, stored[row.ID])
				}
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Errorf("Legacy IDs %v, want %v", ids, tc.want)
			}
			app, _, err := db.AppRecentRequests(ctx, AppRequestFilter{From: tc.from, To: tc.to, Limit: tc.limit, Model: "public-model", IP: "192.0.2.78"})
			if err != nil {
				t.Fatal(err)
			}
			appIDs := []string{}
			for _, row := range app {
				appIDs = append(appIDs, row.RequestID)
			}
			if !reflect.DeepEqual(ids, appIDs) {
				t.Errorf("Legacy IDs %v differ from App %v", ids, appIDs)
			}
		})
	}
}

func TestRecentRequestsPreservesLegacyProjectionRows(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	id := strings.Repeat("public", 100)
	at := time.Date(2026, 11, 18, 0, 0, 0, 123456789, time.UTC)
	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{ID: id, TraceID: "legacy-large", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: at}}); err != nil {
		t.Fatal(err)
	}
	rows, err := db.RecentRequests(ctx, RequestFilter{From: at, To: at, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != id || rows[0].CreatedAt != at.Format(time.RFC3339Nano) {
		t.Fatalf("Legacy projection lost an existing row: %+v", rows)
	}
}

// The actual query must seek the chronological index without planner hints.
// Rebuild on a populated database to exercise the upgrade, not just fresh schema creation.
func TestRecentRequestsChronologicalIndexUpgradeAndNaturalPlan(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	if _, err := db.db.ExecContext(ctx, "DROP INDEX idx_request_logs_legacy_time"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, db.bind("INSERT INTO request_logs (id,trace_id,api_key_id,method,client_ip,model,endpoint,stream,provider,status_code,latency_ms,first_chunk_ms,session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20000; i++ {
		id := fmt.Sprintf("legacy-plan-%06d", i)
		at := base.Add(time.Duration(i)*time.Second + time.Duration(i%1000)*time.Nanosecond)
		if _, err = stmt.ExecContext(ctx, id, id, "", "POST", "192.0.2.78", "public", "/v1/chat/completions", 0, "public", 200, 10, 0, "", at.Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
	}
	stmt.Close()
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	if _, err = db.db.ExecContext(ctx, "ANALYZE request_logs"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil || count != 20000 {
		t.Fatalf("migration changed rows: count=%d err=%v", count, err)
	}
	for _, tc := range []struct {
		name   string
		filter RequestFilter
	}{
		{"latest", RequestFilter{Limit: 50}},
		{"range", RequestFilter{Limit: 50, From: base.Add(10000 * time.Second), To: base.Add(10010 * time.Second)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query, args := db.recentRequestsQuery(tc.filter)
			var plan string
			if db.dialect == "postgres" {
				var root postgresPlanNode
				plan, root = explainNaturalPostgresAppRequestQuery(t, db, query, args...)
				for _, node := range planNodesForRelation(&root, "request_logs") {
					if node.ActualRows*node.ActualLoops > 150 {
						t.Fatalf("bounded Legacy query read too much history: %.0f rows\n%s", node.ActualRows*node.ActualLoops, plan)
					}
				}
			} else {
				plan = explainAppRequestQuery(t, db, query, args...)
			}
			t.Logf("natural %s plan:\n%s", tc.name, plan)
			if !strings.Contains(plan, "idx_request_logs_legacy_time") {
				t.Fatalf("chronological index not selected:\n%s", plan)
			}
			if strings.Contains(plan, "USE TEMP B-TREE FOR ORDER BY") {
				t.Fatalf("full history sorted:\n%s", plan)
			}
			if tc.name == "range" && db.dialect == "sqlite" && !strings.Contains(plan, "SEARCH r USING INDEX idx_request_logs_legacy_time") {
				t.Fatalf("range did not seek:\n%s", plan)
			}
			if tc.name == "range" && db.dialect == "postgres" && !strings.Contains(plan, `"Index Cond"`) {
				t.Fatalf("range has no index condition:\n%s", plan)
			}
			rows, err := db.RecentRequests(ctx, tc.filter)
			if err != nil {
				t.Fatal(err)
			}
			want := 50
			if tc.name == "range" {
				want = 10
			}
			if len(rows) != want {
				t.Fatalf("rows=%d want=%d", len(rows), want)
			}
		})
	}
}

func TestLegacyRequestChronologicalIndexBuildsConcurrently(t *testing.T) {
	found := false
	for _, statement := range migrationStatements() {
		if !strings.Contains(statement, "idx_request_logs_legacy_time") {
			continue
		}
		found = true
		if !strings.Contains(renderForDialect(statement, "postgres"), "CREATE INDEX CONCURRENTLY IF NOT EXISTS") {
			t.Fatal("PostgreSQL chronological index would block writers")
		}
		if strings.Contains(renderForDialect(statement, "sqlite"), "CONCURRENTLY") {
			t.Fatal("SQLite received PostgreSQL DDL")
		}
		if strings.Contains(statement, " WHERE ") {
			t.Fatal("Legacy rows must not inherit App projection filters")
		}
	}
	if !found {
		t.Fatal("missing chronological index")
	}
}
