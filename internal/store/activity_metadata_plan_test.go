package store

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Exercise the natural planner on selective windows among retained history.
// Do not disable sequential scans or force an index in either engine.
func TestActivitySummaryIndexedWindow(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := t.Context()
	now := time.Date(2026, 11, 17, 3, 30, 0, 0, time.UTC)
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	queries := []string{
		`INSERT INTO request_logs(id, trace_id, endpoint, stream, status_code, latency_ms, provider, created_at) VALUES (?, '', '/v1/chat/completions', 0, 503, 1, 'fixture', ?)`,
		`INSERT INTO alert_events(id, rule_id, rule_name, metric, value, threshold, delivered, created_at) VALUES (?, 'fixture', 'fixture', 'requests', 5, 1, 0, ?)`,
		`INSERT INTO admin_audit_logs(id, action, created_at) VALUES (?, 'provider.update', ?)`,
	}
	for _, query := range queries {
		stmt, err := tx.PrepareContext(ctx, db.bind(query))
		if err != nil {
			t.Fatal(err)
		}
		for i := range 8005 {
			at := now.Add(-365 * 24 * time.Hour).Add(time.Duration(i) * time.Minute)
			if i >= 8000 {
				at = now.Add(-time.Minute).Add(time.Duration(i-8000) * time.Nanosecond)
			}
			if _, err := stmt.ExecContext(ctx, fmt.Sprintf("activity-plan-%05d", i), formatTime(at)); err != nil {
				t.Fatal(err)
			}
		}
		stmt.Close()
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	where, args := metadataTimestampWindowSQL("created_at", now.Add(-time.Hour), now)
	for _, table := range []string{"request_logs", "alert_events", "admin_audit_logs"} {
		if _, err := db.db.ExecContext(ctx, "ANALYZE "+table); err != nil {
			t.Fatal(err)
		}
		query := "SELECT created_at FROM " + table + " WHERE " + where + " ORDER BY " + metadataTimestampOrderSQL("created_at") + " DESC LIMIT 6"
		if table == "request_logs" {
			query = "SELECT provider, substr(created_at,1,13), COUNT(*) FROM request_logs WHERE " + where + " GROUP BY provider, substr(created_at,1,13)"
		}
		expectedIndex := "idx_" + table + "_created_at"
		if db.dialect == "postgres" {
			var raw []byte
			if err := db.db.QueryRowContext(ctx, db.bind("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query), args...).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(raw), expectedIndex) || strings.Contains(string(raw), `"Node Type": "Seq Scan"`) {
				t.Fatalf("%s window lost indexed range search", table)
			}
		} else {
			rows, err := db.db.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query, args...)
			if err != nil {
				t.Fatal(err)
			}
			indexed := false
			for rows.Next() {
				var id, parent, unused int
				var detail string
				if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(detail, "SEARCH ") && strings.Contains(detail, expectedIndex) {
					indexed = true
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil || !indexed {
				t.Fatalf("%s window lost indexed range search: %v", table, err)
			}
		}
		t.Logf("activity_window_plan dialect=%s table=%s retained=8000 selected=5 index=%s", db.dialect, table, expectedIndex)
	}
	signals, err := db.IncidentSignals(ctx, now.Add(-time.Hour), now)
	if err != nil || len(signals) != 1 || signals[0].Requests != 5 || signals[0].Errors5xx != 5 {
		t.Fatal("indexed incident result differs from selected window")
	}
	alerts, err := db.RecentAlertEventMetadata(ctx, now.Add(-time.Hour), now)
	if err != nil || len(alerts) != 5 {
		t.Fatal("indexed alert result differs from selected window")
	}
	audits, err := db.RecentAdminAuditMetadata(ctx, now.Add(-time.Hour), now)
	if err != nil || len(audits) != 5 {
		t.Fatal("indexed audit result differs from selected window")
	}
}
