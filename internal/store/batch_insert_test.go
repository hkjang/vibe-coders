package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// A request can carry many rows of one kind — a prompt per message, an evaluation per
// rubric dimension, a tool invocation per call. They go in as one statement now, and every
// one of them still has to come back with its values in the right columns.
func TestManyRowsOfOneKindAllLand(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	const n = 40
	record := LogRecord{
		Request: RequestLog{ID: "r-batch", TraceID: "t-batch", APIKeyID: "k1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now},
	}
	for i := 0; i < n; i++ {
		record.Prompts = append(record.Prompts, PromptLog{
			ID: fmt.Sprintf("p%02d", i), RequestID: "r-batch", Role: "user",
			ContentHash: fmt.Sprintf("h%02d", i), ContentText: fmt.Sprintf("text %d", i),
			RedactedText: fmt.Sprintf("red %d", i), LanguageHint: "ko"})
		record.Evaluations = append(record.Evaluations, LLMEvaluation{
			ID: fmt.Sprintf("e%02d", i), RequestID: "r-batch", TraceID: "t-batch",
			Name: fmt.Sprintf("rubric-%d", i), Category: "safety", Evaluator: "builtin",
			Score: float64(i), Label: "ok", Passed: i%2 == 0, Reason: fmt.Sprintf("because %d", i)})
		record.Languages = append(record.Languages, LanguageStat{
			ID: fmt.Sprintf("l%02d", i), RequestID: "r-batch",
			Language: fmt.Sprintf("lang-%d", i), Confidence: float64(i) / 100, Evidence: "kw"})
		record.Tools = append(record.Tools, ToolInvocation{
			ID: fmt.Sprintf("v%02d", i), RequestID: "r-batch", TraceID: "t-batch", APIKeyID: "k1",
			ServerLabel: "srv", ToolName: fmt.Sprintf("tool-%d", i), Source: "call",
			IsMCP: true, IsError: i%3 == 0, ArgSensitive: i%5 == 0, ArgHash: fmt.Sprintf("a%02d", i)})
	}
	if err := db.InsertLogRecord(ctx, record); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ table, want string }{
		{"prompt_logs", ""}, {"llm_evaluations", ""}, {"language_stats", ""}, {"tool_invocations", ""},
	} {
		var count int
		if err := db.db.QueryRowContext(ctx, db.bind(
			`SELECT COUNT(*) FROM `+tc.table+` WHERE request_id = ?`), "r-batch").Scan(&count); err != nil {
			t.Fatalf("%s: %v", tc.table, err)
		}
		if count != n {
			t.Errorf("%s holds %d rows, want %d", tc.table, count, n)
		}
	}

	// Values in the right columns, not just the right number of rows: a flat argument list
	// is exactly what shifts a column without any constraint noticing.
	var role, hash, text, redacted, hint string
	if err := db.db.QueryRowContext(ctx, db.bind(
		`SELECT role, content_hash, content_text, redacted_text, language_hint FROM prompt_logs WHERE id = ?`),
		"p07").Scan(&role, &hash, &text, &redacted, &hint); err != nil {
		t.Fatal(err)
	}
	if role != "user" || hash != "h07" || text != "text 7" || redacted != "red 7" || hint != "ko" {
		t.Errorf("prompt p07 came back as role=%q hash=%q text=%q redacted=%q hint=%q", role, hash, text, redacted, hint)
	}

	var name, category, reason string
	var score float64
	var passed int
	if err := db.db.QueryRowContext(ctx, db.bind(
		`SELECT name, category, score, passed, reason FROM llm_evaluations WHERE id = ?`),
		"e09").Scan(&name, &category, &score, &passed, &reason); err != nil {
		t.Fatal(err)
	}
	if name != "rubric-9" || category != "safety" || score != 9 || passed != 0 || reason != "because 9" {
		t.Errorf("evaluation e09 came back as name=%q category=%q score=%v passed=%d reason=%q",
			name, category, score, passed, reason)
	}
}

// More rows than one statement can bind have to be split across statements rather than
// failing or silently dropping the remainder.
func TestMoreRowsThanOneStatementCanBind(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// prompt_logs binds 8 values a row, so this needs several statements.
	n := (batchParamLimit/8)*2 + 5
	record := LogRecord{
		Request: RequestLog{ID: "r-big", TraceID: "t", APIKeyID: "k1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now},
	}
	for i := 0; i < n; i++ {
		record.Prompts = append(record.Prompts, PromptLog{
			ID: fmt.Sprintf("bp%05d", i), RequestID: "r-big", Role: "user",
			ContentHash: "h", ContentText: fmt.Sprintf("%d", i)})
	}
	if err := db.InsertLogRecord(ctx, record); err != nil {
		t.Fatalf("%d prompts in one record: %v", n, err)
	}
	var count int
	if err := db.db.QueryRowContext(ctx, db.bind(
		`SELECT COUNT(*) FROM prompt_logs WHERE request_id = ?`), "r-big").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != n {
		t.Fatalf("wrote %d prompts, stored %d", n, count)
	}
}

// A caller whose argument list does not divide evenly into rows has miscounted, and
// writing it anyway would shift every value after the mistake into the wrong column.
func TestBatchInsertRefusesAMiscountedArgumentList(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	err = batchInsert(ctx, tx, db.bind, `INSERT INTO language_stats (id, request_id, language, confidence, evidence, created_at)`,
		"(?, ?, ?, ?, ?, ?)", 6, []any{"a", "b", "c"})
	if err == nil {
		t.Fatal("three values were accepted for a six-column row")
	}
}

func TestBatchInsertWithNoRows(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := batchInsert(ctx, tx, db.bind, `INSERT INTO language_stats (id, request_id, language, confidence, evidence, created_at)`,
		"(?, ?, ?, ?, ?, ?)", 6, nil); err != nil {
		t.Fatalf("no rows must not build a statement with no VALUES: %v", err)
	}
}
