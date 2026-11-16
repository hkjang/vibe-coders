//go:build linux

package proxy

import (
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func seedBrowserOverviewFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	when := time.Now().UTC().Add(-10 * time.Minute)
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{ID: "browser-overview-trend", TraceID: "browser-overview-trend", Endpoint: "/v1/chat/completions", Model: "synthetic-trend", StatusCode: 200, CreatedAt: when},
		Usage:   &store.TokenUsage{ID: "browser-overview-trend-usage", RequestID: "browser-overview-trend", TotalTokens: 19, EstimatedCost: 0.0004, Currency: "KRW", Source: "fixture", CreatedAt: when},
	}); err != nil {
		t.Fatal("overview browser fixture could not be seeded")
	}
}
