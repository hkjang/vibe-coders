package store

import (
	"context"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestRetentionCheckedDoesNotReportSuccessForClosedStorage(t *testing.T) {
	db := openAggTestStore(t)
	worker := NewRetentionWorker(db, config.RetentionConfig{RequestDays: 1})
	if err := db.Close(); err != nil {
		t.Fatal("close failed")
	}
	deleted, err := worker.RunOnceChecked(context.Background())
	if err == nil || deleted != 0 {
		t.Fatal("failed cleanup must expose failure, not an empty success")
	}
}

func TestRetentionCheckedReportsPartialProgress(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
		ID: "expired-operation-fixture", TraceID: "expired-operation-fixture", Endpoint: "/v1/chat/completions",
		StatusCode: 200, CreatedAt: time.Now().UTC().Add(-96 * time.Hour),
	}}); err != nil {
		t.Fatal("seed failed")
	}
	// Isolated test database/schema only. A late stage fails after request purge.
	if _, err := db.db.ExecContext(ctx, "ALTER TABLE chat_semantic_cache RENAME TO unavailable_chat_semantic_cache"); err != nil {
		t.Fatal("fixture fault setup failed")
	}
	defer db.db.ExecContext(ctx, "ALTER TABLE unavailable_chat_semantic_cache RENAME TO chat_semantic_cache")
	worker := NewRetentionWorker(db, config.RetentionConfig{RequestDays: 1})
	deleted, err := worker.RunOnceChecked(ctx)
	if err == nil || deleted < 1 {
		t.Fatal("partial cleanup must retain its count and expose failure")
	}
	requests, _, _, countErr := db.Counts(ctx)
	if countErr != nil || requests != 0 {
		t.Fatal("fixture must prove request deletion preceded the later failure")
	}
}

func TestRetentionCheckedReportsCancellation(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	worker := NewRetentionWorker(db, config.RetentionConfig{})
	if _, err := worker.RunOnceChecked(ctx); err == nil {
		t.Fatal("cancelled cleanup must not report success")
	}
}
