//go:build linux

package proxy

import (
	"strconv"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedBrowserRequestBulkFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	now := time.Now().UTC()
	for i := 1; i <= 3; i++ {
		id := "browser-bulk-request-" + strconv.Itoa(i)
		when := now.Add(-time.Duration(i) * time.Minute)
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", Model: "synthetic-bulk-selection", StatusCode: 200, CreatedAt: when},
			Usage:   &store.TokenUsage{ID: id + "-usage", RequestID: id, TotalTokens: 19, EstimatedCost: float64(i) * 0.0004, Currency: "KRW", Source: "fixture", CreatedAt: when},
		}); err != nil {
			t.Fatal("request selection browser fixture could not be seeded")
		}
	}
}
