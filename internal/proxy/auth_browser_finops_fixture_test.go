//go:build linux

package proxy

import (
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedBrowserFinopsFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	when := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{ID: "browser_finops_csv", TraceID: "browser_finops_csv", Project: "=1+1", StatusCode: 500, CreatedAt: when},
		Usage:   &store.TokenUsage{ID: "browser_finops_csv_usage", RequestID: "browser_finops_csv", TotalTokens: 7, EstimatedCost: 12.3, Currency: "KRW", CreatedAt: when},
	}); err != nil {
		t.Fatal("browser cost fixture could not be seeded")
	}
}
