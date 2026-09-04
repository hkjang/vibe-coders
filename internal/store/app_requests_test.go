package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestAppRecentRequestsKeysetAndFilters(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	tiedAt := time.Date(2026, 9, 3, 1, 2, 3, 4, time.UTC)
	for _, item := range []struct {
		id, provider string
		status       int
	}{
		{id: "req-a", provider: "provider-a", status: 200},
		{id: "req-c", provider: "provider-a", status: 200},
		{id: "req-b", provider: "provider-b", status: 500},
	} {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: item.id, TraceID: "trace-" + item.id, APIKeyID: "key-a",
				ClientIP: "192.0.2.10", Model: "model-a", Provider: item.provider,
				Endpoint: "/v1/chat/completions", StatusCode: item.status, CreatedAt: tiedAt},
			Languages: []LanguageStat{{ID: "lang-" + item.id, RequestID: item.id, Language: "ko", Confidence: .9, CreatedAt: tiedAt}},
		}); err != nil {
			t.Fatal(err)
		}
	}

	first, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, Language: "ko", StatusMin: 200, StatusMax: 599})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(first) != 1 || first[0].RequestID != "req-c" {
		t.Fatalf("first page = %+v more=%v", first, more)
	}
	second, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, CursorAt: first[0].CreatedAt, CursorID: first[0].RequestID, Direction: "older"})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(second) != 1 || second[0].RequestID != "req-b" {
		t.Fatalf("second page = %+v more=%v", second, more)
	}
	previous, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, CursorAt: second[0].CreatedAt, CursorID: second[0].RequestID, Direction: "newer"})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(previous) != 1 || previous[0].RequestID != "req-c" {
		t.Fatalf("previous page = %+v more=%v", previous, more)
	}
	filtered, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 20, Provider: "provider-b", ProviderSet: true, StatusCode: 500, IP: "192.0.2.10"})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].RequestID != "req-b" {
		t.Fatalf("filtered page = %+v", filtered)
	}
}

func TestAppRecentRequestsTraceFilterKeepsStableKeyset(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	for _, item := range []struct {
		id      string
		traceID string
		at      time.Time
	}{
		{id: "trace-request-a", traceID: "shared-trace", at: base},
		{id: "trace-request-b", traceID: "shared-trace", at: base.Add(time.Nanosecond)},
		{id: "trace-request-c", traceID: "shared-trace", at: base.Add(time.Nanosecond)},
		{id: "other-request", traceID: "other-trace", at: base.Add(2 * time.Nanosecond)},
	} {
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
			ID: item.id, TraceID: item.traceID, Endpoint: "/v1/chat/completions",
			StatusCode: 200, CreatedAt: item.at,
		}}); err != nil {
			t.Fatal(err)
		}
	}

	first, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, TraceID: "shared-trace"})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(first) != 1 || first[0].RequestID != "trace-request-c" {
		t.Fatalf("first trace page = %+v more=%v", first, more)
	}
	second, more, err := db.AppRecentRequests(ctx, AppRequestFilter{
		Limit: 1, TraceID: "shared-trace", CursorAt: first[0].CreatedAt,
		CursorID: first[0].RequestID, Direction: "older",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(second) != 1 || second[0].RequestID != "trace-request-b" {
		t.Fatalf("second trace page = %+v more=%v", second, more)
	}
	newer, more, err := db.AppRecentRequests(ctx, AppRequestFilter{
		Limit: 1, TraceID: "shared-trace", CursorAt: second[0].CreatedAt,
		CursorID: second[0].RequestID, Direction: "newer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(newer) != 1 || newer[0].RequestID != "trace-request-c" {
		t.Fatalf("newer trace page = %+v more=%v", newer, more)
	}
}

func TestAppRecentRequestsOrdersVariableRFC3339NanoChronologically(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC)

	for _, item := range []struct {
		id string
		at time.Time
	}{
		{id: "req-next-second", at: base.Add(time.Second)},
		{id: "req-exact", at: base},
		{id: "req-fraction", at: base.Add(500 * time.Millisecond)},
	} {
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
			ID: item.id, TraceID: "trace-" + item.id, Model: "model-a", Provider: "provider-a",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: item.at,
		}}); err != nil {
			t.Fatal(err)
		}
	}

	all, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(all) != 3 || all[0].RequestID != "req-next-second" ||
		all[1].RequestID != "req-fraction" || all[2].RequestID != "req-exact" {
		t.Fatalf("chronological page = %+v more=%v", all, more)
	}
	for _, item := range all {
		if len(item.CreatedAt) != len(appRequestTimeLayout) || item.CreatedAt[len(item.CreatedAt)-1] != 'Z' {
			t.Fatalf("created_at was not canonicalized: %q", item.CreatedAt)
		}
	}

	fromExact, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10, From: base})
	if err != nil {
		t.Fatal(err)
	}
	if len(fromExact) != 3 {
		t.Fatalf("from exact second excluded a fractional instant: %+v", fromExact)
	}
	toExact, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10, To: base})
	if err != nil {
		t.Fatal(err)
	}
	if len(toExact) != 1 || toExact[0].RequestID != "req-exact" {
		t.Fatalf("to exact second included a later fractional instant: %+v", toExact)
	}

	first, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1})
	if err != nil || !more || len(first) != 1 || first[0].RequestID != "req-next-second" {
		t.Fatalf("first page = %+v more=%v err=%v", first, more, err)
	}
	second, more, err := db.AppRecentRequests(ctx, AppRequestFilter{
		Limit: 1, CursorAt: first[0].CreatedAt, CursorID: first[0].RequestID, Direction: "older",
	})
	if err != nil || !more || len(second) != 1 || second[0].RequestID != "req-fraction" {
		t.Fatalf("second page = %+v more=%v err=%v", second, more, err)
	}
	third, more, err := db.AppRecentRequests(ctx, AppRequestFilter{
		Limit: 1, CursorAt: second[0].CreatedAt, CursorID: second[0].RequestID, Direction: "older",
	})
	if err != nil || more || len(third) != 1 || third[0].RequestID != "req-exact" {
		t.Fatalf("third page = %+v more=%v err=%v", third, more, err)
	}
	newer, more, err := db.AppRecentRequests(ctx, AppRequestFilter{
		Limit: 1, CursorAt: third[0].CreatedAt, CursorID: third[0].RequestID, Direction: "newer",
	})
	if err != nil || !more || len(newer) != 1 || newer[0].RequestID != "req-fraction" {
		t.Fatalf("newer page = %+v more=%v err=%v", newer, more, err)
	}

	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE request_logs SET created_at = ? WHERE id = ?`),
		"2026-09-03X01:02:03Z", "req-exact"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10}); err == nil {
		t.Fatal("malformed created_at was silently projected")
	}
}

func TestAppRecentRequestsSelectsLatestChildWithoutDuplicatingPage(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC)
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "request-with-retry", TraceID: "trace-with-retry",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: base},
		Usage: &TokenUsage{ID: "usage-old", RequestID: "request-with-retry", PromptTokens: 1,
			CompletionTokens: 1, TotalTokens: 2, Currency: "KRW", Source: "usage", CreatedAt: base},
		Response: &ResponseLog{ID: "response-old", RequestID: "request-with-retry", StatusCode: 200,
			FinishReason: "old", ResponseHash: "old-hash", CreatedAt: base},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO token_usage
		(id, request_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
		 reasoning_tokens, estimated_cost, currency, source, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		"usage-new", "request-with-retry", 3, 5, 8, 1, 2, 12.5, "KRW", "usage", formatTime(base.Add(500*time.Millisecond))); err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO response_logs
		(id, request_id, status_code, finish_reason, response_hash, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`),
		"response-new", "request-with-retry", 200, "new", "new-hash", formatTime(base.Add(500*time.Millisecond))); err != nil {
		t.Fatal(err)
	}

	items, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(items) != 1 {
		t.Fatalf("duplicate child rows changed page cardinality: items=%+v more=%v", items, more)
	}
	if items[0].TotalTokens != 8 || items[0].CachedTokens != 1 ||
		items[0].ReasoningTokens != 2 || items[0].FinishReason != "new" {
		t.Fatalf("latest child metadata was not selected: %+v", items[0])
	}
}

func TestAppRecentRequestsNormalizedCursorUsesExpressionIndex(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	base := time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC)
	for index := 0; index < 8; index++ {
		id := fmt.Sprintf("index-row-%02d", index)
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
			ID: id, TraceID: id, Endpoint: "/v1/chat/completions", StatusCode: 200,
			CreatedAt: base.Add(time.Duration(index) * time.Nanosecond),
		}}); err != nil {
			t.Fatal(err)
		}
	}

	for _, test := range []struct {
		name      string
		filter    AppRequestFilter
		wantIndex string
	}{
		{
			name:      "default descending",
			filter:    AppRequestFilter{Limit: 5},
			wantIndex: "idx_request_logs_app_valid_cursor",
		},
		{
			name:      "range descending",
			filter:    AppRequestFilter{Limit: 5, From: base},
			wantIndex: "idx_request_logs_app_valid_cursor",
		},
		{
			name: "older cursor",
			filter: AppRequestFilter{Limit: 5, CursorAt: appRequestFixedTime(base.Add(7 * time.Nanosecond)),
				CursorID: "index-row-07", Direction: "older"},
			wantIndex: "idx_request_logs_app_valid_cursor",
		},
		{
			name: "newer cursor",
			filter: AppRequestFilter{Limit: 5, CursorAt: appRequestFixedTime(base),
				CursorID: "index-row-00", Direction: "newer"},
			wantIndex: "idx_request_logs_app_valid_cursor",
		},
		{
			name: "trace exact with cursor",
			filter: AppRequestFilter{Limit: 5, TraceID: "index-row-07",
				CursorAt: appRequestFixedTime(base.Add(7 * time.Nanosecond)),
				CursorID: "index-row-08", Direction: "older"},
			wantIndex: "idx_request_logs_app_trace_valid_cursor",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, args, _, err := db.appRecentRequestsQuery(test.filter)
			if err != nil {
				t.Fatal(err)
			}
			plan := explainAppRequestQuery(t, db, query, args...)
			if !strings.Contains(plan, test.wantIndex) {
				t.Fatalf("normalized cursor index %s is not used:\n%s", test.wantIndex, plan)
			}
			if test.filter.CursorAt != "" && db.dialect == "sqlite" &&
				!strings.Contains(plan, "SEARCH r USING INDEX "+test.wantIndex) {
				t.Fatalf("cursor did not become an expression-index range seek on %s:\n%s", test.wantIndex, plan)
			}
			lower := strings.ToLower(plan)
			if strings.Contains(lower, "scan t") || strings.Contains(lower, "scan resp") ||
				strings.Contains(lower, "seq scan on token_usage") || strings.Contains(lower, "seq scan on response_logs") {
				t.Fatalf("bounded child lookups degraded to full scans:\n%s", plan)
			}
		})
	}
}

func TestMigrateRemovesSupersededAppRequestCursorIndex(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	statement := `CREATE INDEX idx_request_logs_app_cursor ON request_logs(created_at, id)`
	if s := renderForDialect(statement, db.dialect); s != statement {
		statement = s
	}
	if _, err := db.db.ExecContext(ctx, statement); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var count int
	if db.dialect == "postgres" {
		if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*)
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = current_schema() AND c.relname = 'idx_request_logs_app_cursor'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
	} else if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'index' AND name = 'idx_request_logs_app_cursor'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("superseded app request cursor index survived migration")
	}
	report, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !report.InSync() {
		t.Fatalf("replacement indexes drift after cleanup: %+v", report.Items)
	}
}

func TestAppTraceCursorIndexRendersForBothDialects(t *testing.T) {
	const indexName = "idx_request_logs_app_trace_valid_cursor"
	var declared string
	for _, statement := range migrationStatements() {
		if strings.Contains(statement, indexName) {
			declared = statement
			break
		}
	}
	if declared == "" {
		t.Fatalf("%s is not declared", indexName)
	}

	sqlite := renderForDialect(declared, "sqlite")
	if strings.Contains(sqlite, "CONCURRENTLY") || !strings.Contains(sqlite, "CAST(trace_id AS BLOB)") {
		t.Fatalf("unsafe SQLite trace index rendering: %s", sqlite)
	}
	postgres := renderForDialect(declared, "postgres")
	if !strings.Contains(postgres, "CREATE INDEX CONCURRENTLY IF NOT EXISTS") ||
		!strings.Contains(postgres, "CAST(trace_id AS BYTEA)") {
		t.Fatalf("unsafe PostgreSQL trace index rendering: %s", postgres)
	}
	for _, test := range []struct {
		dialect string
		sql     string
	}{{dialect: "sqlite", sql: sqlite}, {dialect: "postgres", sql: postgres}} {
		validRow := renderForDialect(appRequestValidRowPredicate("id", "created_at"), test.dialect)
		if !strings.Contains(test.sql, "ON request_logs(trace_id,") ||
			!strings.Contains(test.sql, appRequestCreatedAtExpr("created_at")) ||
			!strings.Contains(test.sql, validRow) {
			t.Fatalf("%s trace cursor shape or valid-row predicate missing: %s", test.dialect, test.sql)
		}
	}
}

func TestMigrateAppRequestIndexesIgnoreOversizedLegacyKeys(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	for _, name := range []string{
		"idx_api_keys_team_id",
		"idx_request_logs_app_valid_cursor",
		"idx_request_logs_app_team_valid_cursor",
		"idx_request_logs_app_trace_valid_cursor",
		"idx_token_usage_request_latest",
		"idx_response_logs_request_latest",
	} {
		statement := "DROP INDEX IF EXISTS " + name
		if db.dialect == "postgres" {
			statement = "DROP INDEX CONCURRENTLY IF EXISTS " + name
		}
		if _, err := db.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("drop %s: %v", name, err)
		}
	}

	createdAt := appRequestFixedTime(time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC))
	oversizedKeyID := incompressibleAppRequestText("key", 1500)
	oversizedTeam := incompressibleAppRequestText("team", 1500)
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO api_keys
		(id, name, key_hash, team, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
		oversizedKeyID, "legacy oversized key", "legacy-oversized-key-hash",
		oversizedTeam, "active", createdAt); err != nil {
		t.Fatal(err)
	}

	requestID := incompressibleAppRequestText("request", 500)
	oversizedTraceID := incompressibleAppRequestText("trace", 5000)
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO request_logs
		(id, trace_id, api_key_id, endpoint, stream, status_code, latency_ms,
		 first_chunk_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		requestID, oversizedTraceID, "normal-key", "/v1/chat/completions",
		0, 200, 12, 4, createdAt); err != nil {
		t.Fatal(err)
	}
	oversizedUsageID := incompressibleAppRequestText("usage", 2200)
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO token_usage
		(id, request_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
		 reasoning_tokens, estimated_cost, currency, source, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		oversizedUsageID, requestID, 10, 20, 30, 0, 0, 1.5, "KRW", "legacy", createdAt); err != nil {
		t.Fatal(err)
	}
	oversizedResponseID := incompressibleAppRequestText("response", 2200)
	if _, err := db.db.ExecContext(ctx, db.bind(`INSERT INTO response_logs
		(id, request_id, status_code, finish_reason, response_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`),
		oversizedResponseID, requestID, 200, "legacy", "legacy-response-hash", createdAt); err != nil {
		t.Fatal(err)
	}

	// These values fit their individual legacy indexes but would exceed a
	// PostgreSQL btree tuple once combined. Partial guards must let an upgrade
	// rebuild the new composite indexes without leaving an invalid shell.
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate with oversized legacy keys: %v", err)
	}
	items, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(items) != 1 || items[0].RequestID != requestID {
		t.Fatalf("unexpected request page: items=%+v more=%v", items, more)
	}
	if items[0].TotalTokens != 0 || items[0].FinishReason != "" {
		t.Fatalf("oversized child identifiers crossed the projection boundary: %+v", items[0])
	}
	if db.dialect == "postgres" {
		var invalid int
		if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*)
			FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = current_schema() AND NOT i.indisvalid
				AND c.relname IN ('idx_api_keys_team_id',
					'idx_request_logs_app_valid_cursor',
					'idx_request_logs_app_team_valid_cursor',
					'idx_request_logs_app_trace_valid_cursor',
					'idx_token_usage_request_latest',
					'idx_response_logs_request_latest')`).Scan(&invalid); err != nil {
			t.Fatal(err)
		}
		if invalid != 0 {
			t.Fatalf("migration left %d invalid app request indexes", invalid)
		}
	}
	report, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !report.InSync() {
		t.Fatalf("app request indexes drift after guarded migration: %+v", report.Items)
	}
}

func incompressibleAppRequestText(namespace string, size int) string {
	var value strings.Builder
	for sequence := 0; value.Len() < size; sequence++ {
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s-%d", namespace, sequence)))
		value.WriteString(hex.EncodeToString(digest[:]))
	}
	return value.String()[:size]
}

func explainAppRequestQuery(t *testing.T, db *SQLStore, query string, args ...any) string {
	t.Helper()
	ctx := t.Context()
	var lines []string
	if db.dialect == "postgres" {
		tx, err := db.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
			t.Fatal(err)
		}
		// Tiny test fixtures make a bitmap scan plus sort look artificially cheap.
		// Disable it with the sequential scan so EXPLAIN proves the ordered btree
		// path is eligible; production remains free to choose by actual table size.
		if _, err := tx.ExecContext(ctx, `SET LOCAL enable_bitmapscan = off`); err != nil {
			t.Fatal(err)
		}
		rows, err := tx.QueryContext(ctx, `EXPLAIN (COSTS OFF) `+db.bind(query), args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			lines = append(lines, line)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return strings.Join(lines, "\n")
	}

	rows, err := db.db.QueryContext(ctx, `EXPLAIN QUERY PLAN `+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(lines, "\n")
}

func TestAppRecentRequestsPostgresNaturalPlannerAtScale(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") == "" {
		t.Skip("set TEST_POSTGRES_DSN to verify the production planner")
	}
	db := openStoreForTest(t)
	defer db.Close()
	if db.dialect != "postgres" {
		t.Skip("PostgreSQL planner regression")
	}
	ctx := t.Context()
	// The initial test-store migration creates statistics against empty tables.
	// Remove them so the second migration below represents the first upgrade of
	// a populated pre-v0.82.1 installation.
	for _, name := range []string{"app_request_guard_stats_v2", "app_request_key_guard_stats_v1"} {
		if _, err := db.db.ExecContext(ctx, `DROP STATISTICS IF EXISTS `+name); err != nil {
			t.Fatalf("drop empty planner statistics %s: %v", name, err)
		}
	}
	const rows = 200_000
	statements := []string{
		`INSERT INTO api_keys (id, name, key_hash, team, status, created_at)
			SELECT 'planner-key-' || g, 'planner key ' || g, 'planner-hash-' || g,
				CASE WHEN g <= 10 THEN 'team-a' ELSE 'team-b' END,
				'active', '2026-09-01T00:00:00Z'
			FROM generate_series(1, 100) g`,
		`INSERT INTO request_logs
			(id, trace_id, api_key_id, method, client_ip, model, endpoint, stream,
			 provider, status_code, latency_ms, first_chunk_ms, session_id, created_at)
			SELECT 'planner-req-' || lpad(g::text, 12, '0'), 'planner-trace-' || (g % 100),
				'planner-key-' || ((g % 100) + 1), 'POST', '192.0.2.1', 'model-a',
				'/v1/chat/completions', 0, 'provider-a', 200, 10, 5,
				'planner-session-' || (g % 100),
				to_char(timestamptz '2026-09-01 00:00:00+00' + g * interval '1 second',
					'YYYY-MM-DD"T"HH24:MI:SS.US') || '000Z'
			FROM generate_series(1, 200000) g`,
		`INSERT INTO token_usage
			(id, request_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
			 reasoning_tokens, estimated_cost, currency, source, created_at)
			SELECT 'planner-usage-' || g, 'planner-req-' || lpad(g::text, 12, '0'),
				10, 20, 30, 0, 0, 0.01, 'KRW', 'usage', '2026-09-01T00:00:00Z'
			FROM generate_series(1, 200000) g`,
		`INSERT INTO response_logs
			(id, request_id, status_code, finish_reason, response_hash, created_at)
			SELECT 'planner-response-' || g, 'planner-req-' || lpad(g::text, 12, '0'),
				200, 'stop', 'planner-response-hash-' || g, '2026-09-01T00:00:00Z'
			FROM generate_series(1, 200000) g`,
		`ANALYZE token_usage`,
		`ANALYZE response_logs`,
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare %d-row planner fixture: %v", rows, err)
		}
	}
	// Simulate an upgrade of an existing populated database. Migrate must notice
	// that the newly declared expression statistics have no samples yet and run
	// the one-time request_logs ANALYZE itself.
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("refresh request planner statistics: %v", err)
	}
	var guardExpressions int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pg_stats_ext_exprs
		WHERE schemaname = current_schema() AND statistics_schemaname = current_schema()
			AND statistics_name = 'app_request_guard_stats_v2'
			AND n_distinct IS NOT NULL`).Scan(&guardExpressions); err != nil {
		t.Fatal(err)
	}
	if guardExpressions != 3 {
		t.Fatalf("populated guard expression statistics = %d, want 3", guardExpressions)
	}
	var keyGuardExpressions int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pg_stats_ext_exprs
		WHERE schemaname = current_schema() AND statistics_schemaname = current_schema()
			AND statistics_name = 'app_request_key_guard_stats_v1'
			AND n_distinct IS NOT NULL`).Scan(&keyGuardExpressions); err != nil {
		t.Fatal(err)
	}
	if keyGuardExpressions != 2 {
		t.Fatalf("populated API-key guard expression statistics = %d, want 2", keyGuardExpressions)
	}

	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	cursorAt := appRequestFixedTime(base.Add(172_800 * time.Second))
	for _, test := range []struct {
		name      string
		filter    AppRequestFilter
		wantIndex string
	}{
		{name: "default", filter: AppRequestFilter{Limit: 50}},
		{name: "range", filter: AppRequestFilter{Limit: 50, From: base.Add(100_000 * time.Second)}},
		{name: "older", filter: AppRequestFilter{Limit: 50, CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "older"}},
		{name: "newer", filter: AppRequestFilter{Limit: 50, CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "newer"}},
		{name: "team", filter: AppRequestFilter{Limit: 50, Teams: []string{"team-a"}, TeamScoped: true}},
		{name: "trace", filter: AppRequestFilter{Limit: 50, TraceID: "planner-trace-0",
			CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "older"},
			wantIndex: "idx_request_logs_app_trace_valid_cursor"},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, args, _, err := db.appRecentRequestsQuery(test.filter)
			if err != nil {
				t.Fatal(err)
			}
			plan, root := explainNaturalPostgresAppRequestQuery(t, db, query, args...)
			if test.wantIndex != "" && !strings.Contains(plan, test.wantIndex) {
				t.Fatalf("natural planner did not use %s:\n%s", test.wantIndex, plan)
			}
			if !strings.Contains(plan, "idx_request_logs_app_valid_cursor") &&
				!strings.Contains(plan, "idx_request_logs_app_team_valid_cursor") &&
				!strings.Contains(plan, "idx_request_logs_app_trace_valid_cursor") {
				t.Fatalf("natural planner did not use an ordered app cursor index:\n%s", plan)
			}
			for _, table := range []string{"request_logs", "token_usage", "response_logs"} {
				for _, node := range planNodesForRelation(&root, table) {
					if node.NodeType == "Seq Scan" || node.NodeType == "Parallel Seq Scan" {
						t.Fatalf("natural planner scanned %s end to end:\n%s", table, plan)
					}
				}
			}
			for _, indexName := range []string{
				"idx_token_usage_request_latest",
				"idx_response_logs_request_latest",
			} {
				if !strings.Contains(plan, indexName) {
					t.Fatalf("latest child lookup did not use %s:\n%s", indexName, plan)
				}
			}
			pageLimit := deepestLimitForRelation(&root, "request_logs")
			if pageLimit == nil || pageLimit.ActualLoops != 1 || pageLimit.ActualRows > 51 {
				t.Fatalf("inner request page limit was not enforced before child lookups: %+v\n%s", pageLimit, plan)
			}
			for _, nodeType := range []string{"Sort", "Incremental Sort", "Hash Join"} {
				if planContainsNodeType(pageLimit, nodeType) {
					t.Fatalf("inner request page used avoidable %s:\n%s", nodeType, plan)
				}
			}
			for _, node := range planNodesForRelation(pageLimit, "request_logs") {
				if visits := node.ActualRows * node.ActualLoops; visits > 5_000 {
					t.Fatalf("request cursor read %.0f rows, want at most 5000:\n%s", visits, plan)
				}
			}
			for _, relation := range []string{"token_usage", "response_logs"} {
				nodes := planNodesForRelation(&root, relation)
				if len(nodes) == 0 {
					t.Fatalf("no %s lookup node in plan:\n%s", relation, plan)
				}
				for _, node := range nodes {
					if node.ActualLoops > 51 {
						t.Fatalf("%s lookup ran %.0f times, want at most 51:\n%s", relation, node.ActualLoops, plan)
					}
				}
			}
		})
	}
}

func TestAppRecentRequestsSQLiteNaturalPlannerAtScale(t *testing.T) {
	if os.Getenv("TEST_SQLITE_PLANNER") != "1" {
		t.Skip("set TEST_SQLITE_PLANNER=1 to verify the production planner")
	}
	db := openStoreForTest(t)
	defer db.Close()
	if db.dialect != "sqlite" {
		t.Skip("SQLite planner regression")
	}
	ctx := t.Context()
	const rows = 200_000
	statements := []string{
		`WITH RECURSIVE n(g) AS (VALUES(1) UNION ALL SELECT g + 1 FROM n WHERE g < 100)
			INSERT INTO api_keys (id, name, key_hash, team, status, created_at)
			SELECT 'planner-key-' || g, 'planner key ' || g, 'planner-hash-' || g,
				CASE WHEN g <= 10 THEN 'team-a' ELSE 'team-b' END,
				'active', '2026-09-01T00:00:00Z' FROM n`,
		`WITH RECURSIVE n(g) AS (VALUES(1) UNION ALL SELECT g + 1 FROM n WHERE g < 200000)
			INSERT INTO request_logs
			(id, trace_id, api_key_id, method, client_ip, model, endpoint, stream,
			 provider, status_code, latency_ms, first_chunk_ms, session_id, created_at)
			SELECT printf('planner-req-%012d', g), 'planner-trace-' || (g % 100),
				'planner-key-' || ((g % 100) + 1), 'POST', '192.0.2.1', 'model-a',
				'/v1/chat/completions', 0, 'provider-a', 200, 10, 5,
				'planner-session-' || (g % 100),
				strftime('%Y-%m-%dT%H:%M:%S', '2026-09-01 00:00:00', printf('+%d seconds', g)) || '.000000000Z'
			FROM n`,
		`WITH RECURSIVE n(g) AS (VALUES(1) UNION ALL SELECT g + 1 FROM n WHERE g < 200000)
			INSERT INTO token_usage
			(id, request_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
			 reasoning_tokens, estimated_cost, currency, source, created_at)
			SELECT 'planner-usage-' || g, printf('planner-req-%012d', g),
				10, 20, 30, 0, 0, 0.01, 'KRW', 'usage', '2026-09-01T00:00:00Z' FROM n`,
		`WITH RECURSIVE n(g) AS (VALUES(1) UNION ALL SELECT g + 1 FROM n WHERE g < 200000)
			INSERT INTO response_logs
			(id, request_id, status_code, finish_reason, response_hash, created_at)
			SELECT 'planner-response-' || g, printf('planner-req-%012d', g),
				200, 'stop', 'planner-response-hash-' || g, '2026-09-01T00:00:00Z' FROM n`,
		`ANALYZE`,
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare %d-row SQLite planner fixture: %v", rows, err)
		}
	}

	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	cursorAt := appRequestFixedTime(base.Add(172_800 * time.Second))
	for _, test := range []struct {
		name           string
		filter         AppRequestFilter
		requestIndexes []string
		wantSearch     bool
	}{
		{name: "default", filter: AppRequestFilter{Limit: 50}, requestIndexes: []string{"idx_request_logs_app_valid_cursor"}},
		{name: "range", filter: AppRequestFilter{Limit: 50, From: base.Add(100_000 * time.Second)}, requestIndexes: []string{"idx_request_logs_app_valid_cursor"}, wantSearch: true},
		{name: "older", filter: AppRequestFilter{Limit: 50, CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "older"}, requestIndexes: []string{"idx_request_logs_app_valid_cursor"}, wantSearch: true},
		{name: "newer", filter: AppRequestFilter{Limit: 50, CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "newer"}, requestIndexes: []string{"idx_request_logs_app_valid_cursor"}, wantSearch: true},
		{name: "api key", filter: AppRequestFilter{Limit: 50, APIKeyID: "planner-key-1"}, requestIndexes: []string{"idx_request_logs_app_team_valid_cursor"}, wantSearch: true},
		{name: "team", filter: AppRequestFilter{Limit: 50, Teams: []string{"team-a"}, TeamScoped: true}, requestIndexes: []string{"idx_request_logs_app_valid_cursor"}},
		{name: "trace", filter: AppRequestFilter{Limit: 50, TraceID: "planner-trace-0",
			CursorAt: cursorAt, CursorID: "planner-req-000000172800", Direction: "older"},
			requestIndexes: []string{"idx_request_logs_app_trace_valid_cursor"}, wantSearch: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, args, _, err := db.appRecentRequestsQuery(test.filter)
			if err != nil {
				t.Fatal(err)
			}
			plan := explainAppRequestQuery(t, db, query, args...)
			if !strings.Contains(plan, "CO-ROUTINE page") {
				t.Fatalf("SQLite did not preserve the bounded parent-page boundary:\n%s", plan)
			}
			usedIndex := ""
			for _, indexName := range test.requestIndexes {
				if strings.Contains(plan, indexName) {
					usedIndex = indexName
					break
				}
			}
			if usedIndex == "" {
				t.Fatalf("SQLite planner did not use one of %v:\n%s", test.requestIndexes, plan)
			}
			if test.wantSearch && !strings.Contains(plan, "SEARCH r USING INDEX "+usedIndex) {
				t.Fatalf("SQLite planner did not range-seek %s:\n%s", usedIndex, plan)
			}
			for _, indexName := range []string{
				"idx_token_usage_request_latest",
				"idx_response_logs_request_latest",
			} {
				if !strings.Contains(plan, indexName) {
					t.Fatalf("SQLite latest child lookup did not use %s:\n%s", indexName, plan)
				}
			}
			if strings.Contains(plan, "SCAN t_pick") || strings.Contains(plan, "SCAN resp_pick") {
				t.Fatalf("SQLite scanned a child table end to end:\n%s", plan)
			}
			if test.name == "team" && !strings.Contains(plan, "SEARCH k USING INDEX") {
				t.Fatalf("SQLite team scope did not seek API keys by identifier:\n%s", plan)
			}
			if test.name == "team" {
				sortAt := strings.Index(plan, "USE TEMP B-TREE FOR ORDER BY")
				boundedPageAt := strings.Index(plan, "SCAN page")
				if sortAt >= 0 && (boundedPageAt < 0 || sortAt < boundedPageAt) {
					t.Fatalf("SQLite sorted the full team history before applying the page limit:\n%s", plan)
				}
			}
			items, more, err := db.AppRecentRequests(ctx, test.filter)
			if err != nil {
				t.Fatal(err)
			}
			if len(items) != 50 || !more {
				t.Fatalf("unexpected bounded page: items=%d more=%v", len(items), more)
			}
		})
	}
}

type postgresPlanNode struct {
	NodeType     string             `json:"Node Type"`
	RelationName string             `json:"Relation Name"`
	ActualRows   float64            `json:"Actual Rows"`
	ActualLoops  float64            `json:"Actual Loops"`
	Plans        []postgresPlanNode `json:"Plans"`
}

func explainNaturalPostgresAppRequestQuery(t *testing.T, db *SQLStore, query string, args ...any) (string, postgresPlanNode) {
	t.Helper()
	var raw []byte
	if err := db.db.QueryRowContext(t.Context(),
		`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON) `+query, args...).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var document []struct {
		Plan postgresPlanNode `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode PostgreSQL plan: %v\n%s", err, raw)
	}
	if len(document) != 1 {
		t.Fatalf("PostgreSQL returned %d plan documents", len(document))
	}
	return string(raw), document[0].Plan
}

func deepestLimitForRelation(node *postgresPlanNode, relation string) *postgresPlanNode {
	for index := range node.Plans {
		if limit := deepestLimitForRelation(&node.Plans[index], relation); limit != nil {
			return limit
		}
	}
	if node.NodeType == "Limit" && planContainsRelation(node, relation) &&
		!planContainsRelation(node, "token_usage") && !planContainsRelation(node, "response_logs") {
		return node
	}
	return nil
}

func planContainsRelation(node *postgresPlanNode, relation string) bool {
	if node.RelationName == relation {
		return true
	}
	for index := range node.Plans {
		if planContainsRelation(&node.Plans[index], relation) {
			return true
		}
	}
	return false
}

func planContainsNodeType(node *postgresPlanNode, nodeType string) bool {
	if node.NodeType == nodeType {
		return true
	}
	for index := range node.Plans {
		if planContainsNodeType(&node.Plans[index], nodeType) {
			return true
		}
	}
	return false
}

func planNodesForRelation(node *postgresPlanNode, relation string) []*postgresPlanNode {
	nodes := []*postgresPlanNode{}
	if node.RelationName == relation {
		nodes = append(nodes, node)
	}
	for index := range node.Plans {
		nodes = append(nodes, planNodesForRelation(&node.Plans[index], relation)...)
	}
	return nodes
}

func TestAppRequestProviderCandidatesOnlyUsesBoundedConfiguration(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
		ID: "unconfigured-request", TraceID: "unconfigured-request", Model: "model-a",
		Provider: "log-only-provider", Endpoint: "/v1/chat/completions", StatusCode: 200,
		CreatedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: "configured-provider", BaseURL: "https://provider.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	providers, truncated, err := db.AppRequestProviderCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if truncated || len(providers) != 1 || providers[0] != "configured-provider" {
		t.Fatalf("provider candidates = %v truncated=%v", providers, truncated)
	}
	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: strings.Repeat("p", 10_000), BaseURL: "https://provider.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	providers, unsafeOrTruncated, err := db.AppRequestProviderCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !unsafeOrTruncated {
		t.Fatal("oversized configured provider did not fail closed")
	}
	for _, provider := range providers {
		if len(provider) > appRequestReadProviderChars {
			t.Fatalf("provider candidate crossed DB read bound: %d", len(provider))
		}
	}
}

func TestAppRecentRequestsBoundsTextAtDatabaseBoundary(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	huge := strings.Repeat("🧪", 1000)
	// Keep the request-side key below PostgreSQL's older XView composite-index
	// tuple ceiling while still exceeding the projection read bound.
	oversizedAPIKey := strings.Repeat("🧪", appRequestReadIDChars+50)
	now := time.Now().UTC()
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{
			ID: "bounded-row", TraceID: huge, SessionID: huge, APIKeyID: oversizedAPIKey,
			ClientIP: huge, Method: huge, Model: huge, Provider: huge, Endpoint: huge,
			StatusCode: 200, CreatedAt: now,
		},
		Response: &ResponseLog{ID: "bounded-response", RequestID: "bounded-row", FinishReason: huge, CreatedAt: now},
		Usage:    &TokenUsage{ID: "bounded-usage", RequestID: "bounded-row", Currency: huge, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	items, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	item := items[0]
	checks := []struct {
		name  string
		value string
		limit int
	}{
		{name: "trace_id", value: item.TraceID, limit: appRequestReadIDChars},
		{name: "session_id", value: item.SessionID, limit: appRequestReadIDChars},
		{name: "api_key_id", value: item.APIKeyID, limit: appRequestReadIDChars},
		{name: "ip", value: item.IP, limit: appRequestReadIPChars},
		{name: "method", value: item.Method, limit: appRequestReadMethodChars},
		{name: "model", value: item.Model, limit: appRequestReadModelChars},
		{name: "provider", value: item.Provider, limit: appRequestReadProviderChars},
		{name: "endpoint", value: item.Endpoint, limit: appRequestReadEndpointChars},
		{name: "currency", value: item.Currency, limit: appRequestReadCurrencyChars},
		{name: "finish_reason", value: item.FinishReason, limit: appRequestReadFinishReasonChars},
	}
	for _, check := range checks {
		if runes := utf8.RuneCountInString(check.value); runes != check.limit || len(check.value) > 4*check.limit {
			t.Errorf("%s crossed DB read bound: runes=%d bytes=%d limit=%d", check.name, runes, len(check.value), check.limit)
		}
	}
}
