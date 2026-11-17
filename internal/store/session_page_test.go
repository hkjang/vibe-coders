package store

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSessionPageFullSearchTotalsAndScope(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	now := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	for _, key := range []APIKeyRecord{{ID: "key-a", KeyHash: "hash-a", Team: "team-a"}, {ID: "key-b", KeyHash: "hash-b", Team: "team-b"}} {
		if err := db.UpsertAPIKey(t.Context(), key); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(id, session, key, message string, at time.Time) {
		t.Helper()
		if err := db.InsertLogRecord(t.Context(), LogRecord{Request: RequestLog{ID: id, SessionID: session, APIKeyID: key, Model: "m", StatusCode: 500, CreatedAt: at}, Usage: &TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: 2, CreatedAt: at}, Prompts: []PromptLog{{ID: id + "p", RequestID: id, Role: "user", RedactedText: message, CreatedAt: at}}}); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 225 {
		insert(fmt.Sprint("r", i), fmt.Sprintf("session-%03d", i), "key-a", "visible", now.Add(time.Duration(i)*time.Second))
	}
	insert("foreign", "session-224", "key-b", "foreign-secret", now.Add(time.Hour))
	insert("outside", "old-session", "key-a", "outside-window", now.Add(-24*time.Hour))
	q := SessionPageQuery{Since: now.Add(-time.Second), Until: now.Add(2 * time.Hour), Limit: 25, Teams: []string{"team-a"}, TeamScoped: true}
	seen := map[string]bool{}
	for offset := 0; offset < 250; offset += 25 {
		q.Offset = offset
		rows, total, err := db.SessionPage(t.Context(), q)
		if err != nil || total.Sessions != 225 || total.Requests != 225 || total.Errors != 225 || total.Tokens != 2250 || total.Cost != 450 {
			t.Fatalf("totals=%+v err=%v", total, err)
		}
		for _, row := range rows {
			if seen[row.SessionID] || row.LastMessage != "visible" || row.Requests != 1 {
				t.Fatalf("scope/page %+v", row)
			}
			seen[row.SessionID] = true
		}
	}
	if len(seen) != 225 {
		t.Fatal(len(seen))
	}
	q.Offset = 0
	q.Search = "SESSION-000"
	rows, total, err := db.SessionPage(t.Context(), q)
	if err != nil || total.Sessions != 1 || len(rows) != 1 || rows[0].SessionID != "session-000" {
		t.Fatal(rows, total, err)
	}
	q.Search = "visible"
	_, total, err = db.SessionPage(t.Context(), q)
	if err != nil || total.Sessions != 0 {
		t.Fatal("prompt was searched", total, err)
	}
	q.Search = ""
	q.Teams = nil
	_, total, err = db.SessionPage(t.Context(), q)
	if err != nil || total.Sessions != 0 {
		t.Fatal("empty team leaked", total, err)
	}
}
func TestSessionPageLiteralSearchPrecisionAndUsage(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	now := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	for i, id := range []string{"한글_%!", "plain"} {
		at := now.Add(time.Duration(i) * time.Nanosecond)
		if err := db.InsertLogRecord(t.Context(), LogRecord{Request: RequestLog{ID: id, SessionID: id, StatusCode: 200, CreatedAt: at}, Usage: &TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: 2, CreatedAt: at}}); err != nil {
			t.Fatal(err)
		}
	}
	// Multiple usage rows must not duplicate request counts.
	if _, err := db.db.ExecContext(t.Context(), db.bind(`INSERT INTO token_usage(id,request_id,prompt_tokens,completion_tokens,total_tokens,estimated_cost,currency,source,created_at) VALUES(?,?,0,0,20,3,'KRW','test',?)`), "extra", "plain", now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	q := SessionPageQuery{Since: now, Until: now.Add(2 * time.Nanosecond), Limit: 25}
	rows, total, err := db.SessionPage(t.Context(), q)
	if err != nil || len(rows) != 2 || rows[0].SessionID != "plain" || total.Requests != 2 || total.Tokens != 40 || total.Cost != 7 {
		t.Fatal(rows, total, err)
	}
	for _, search := range []string{"_%!", "한글", "%", "_", "!"} {
		q.Search = search
		rows, total, err = db.SessionPage(t.Context(), q)
		if err != nil || total.Sessions != 1 || rows[0].SessionID != "한글_%!" {
			t.Fatal(search, rows, total, err)
		}
	}
	q.Search = ""
	q.Since = now.Add(time.Nanosecond)
	_, total, err = db.SessionPage(t.Context(), q)
	if err != nil || total.Sessions != 1 {
		t.Fatal("boundary", total, err)
	}
	q.Search = strings.Repeat("x", 257)
	if _, _, err = db.SessionPage(t.Context(), q); err == nil {
		t.Fatal("oversize search accepted")
	}
}

func TestSessionPageNaturalPlannerAtScale(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") == "" && os.Getenv("TEST_SQLITE_PLANNER") != "1" {
		t.Skip("opt in natural planner fixture")
	}
	db := openStoreForTest(t)
	defer db.Close()
	now := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	tx, err := db.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(t.Context(), db.bind(`INSERT INTO request_logs(id,session_id,model,created_at,status_code,trace_id,endpoint,stream,latency_ms) VALUES(?,?,?,?,?,'','/v1/chat/completions',0,1)`))
	if err != nil {
		t.Fatal(err)
	}
	for i := range 20000 {
		at := now.Add(-48 * time.Hour)
		if i%200 == 0 {
			at = now
		}
		if _, err = stmt.ExecContext(t.Context(), fmt.Sprint("p-", i), fmt.Sprint("session-", i), "model", at.Format(time.RFC3339Nano), 200); err != nil {
			t.Fatal(err)
		}
	}
	stmt.Close()
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = db.db.ExecContext(t.Context(), "ANALYZE"); err != nil {
		t.Fatal(err)
	}
	q := SessionPageQuery{Since: now.Add(-time.Hour), Until: now.Add(time.Hour), Limit: 25}
	statement, args, err := db.sessionPageSQL(q)
	if err != nil {
		t.Fatal(err)
	}
	var plan string
	if db.dialect == "postgres" {
		_, plan = appFlowNaturalPostgresPlan(t, db, db.bind(renderForDialect(statement, db.dialect)), args...)
	} else {
		plan = explainAppRequestQuery(t, db, statement, args...)
	}
	if !strings.Contains(plan, "idx_request_logs_created_at") {
		t.Fatalf("selective window lacks time index: %s", plan)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	rows, total, err := db.SessionPage(ctx, q)
	if err != nil || len(rows) != 25 || total.Sessions != 100 {
		t.Fatal(len(rows), total, err)
	}
	cancelled, stop := context.WithCancel(t.Context())
	stop()
	if _, _, err = db.SessionPage(cancelled, q); err == nil {
		t.Fatal("ignored cancellation")
	}
}
