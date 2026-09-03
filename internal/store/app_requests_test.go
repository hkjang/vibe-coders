package store

import (
	"context"
	"fmt"
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

	createdAt := appRequestCreatedAtExpr("r.created_at")
	for _, test := range []struct {
		name      string
		predicate string
		order     string
		args      []any
	}{
		{
			name:      "range descending",
			predicate: createdAt + " >= ?",
			order:     createdAt + " DESC, r.id DESC",
			args:      []any{appRequestFixedTime(base), 5},
		},
		{
			name:      "older cursor",
			predicate: "(" + createdAt + ", r.id) < (?, ?)",
			order:     createdAt + " DESC, r.id DESC",
			args:      []any{appRequestFixedTime(base.Add(7 * time.Nanosecond)), "index-row-07", 5},
		},
		{
			name:      "newer cursor",
			predicate: "(" + createdAt + ", r.id) > (?, ?)",
			order:     createdAt + " ASC, r.id ASC",
			args:      []any{appRequestFixedTime(base), "index-row-00", 5},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			query := `SELECT r.id FROM request_logs r
				WHERE length(r.created_at) BETWEEN 20 AND 30 AND ` + test.predicate + `
				ORDER BY ` + test.order + ` LIMIT ?`
			plan := explainAppRequestQuery(t, db, query, test.args...)
			if !strings.Contains(plan, "idx_request_logs_app_cursor") {
				t.Fatalf("normalized cursor index is not used:\n%s", plan)
			}
			lower := strings.ToLower(plan)
			if strings.Contains(lower, "temp b-tree") || strings.Contains(lower, "sort") {
				t.Fatalf("normalized cursor query requires an avoidable sort:\n%s", plan)
			}
		})
	}
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
	now := time.Now().UTC()
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{
			ID: "bounded-row", TraceID: huge, SessionID: huge, APIKeyID: huge,
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
