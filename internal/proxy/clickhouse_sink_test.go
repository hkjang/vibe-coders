package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestClickHouseSink(t *testing.T) {
	var gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := config.ClickHouseConfig{URL: srv.URL, Database: "analytics", Table: "rollups"}
	rows := []store.AnalyticsRollupRow{
		{Day: "2026-06-10", Dimension: "model", DimValue: "gpt-4.1", Requests: 10, Tokens: 100, CostKRW: 5, Errors: 1},
		{Day: "2026-06-10", Dimension: "model", DimValue: "claude", Requests: 3, Tokens: 30, CostKRW: 2, Errors: 0},
	}
	n, err := clickhouseSink(context.Background(), http.DefaultClient, cfg, rows)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("sent %d rows, want 2", n)
	}
	if !strings.Contains(gotQuery, "INSERT INTO analytics.rollups FORMAT JSONEachRow") {
		t.Errorf("unexpected query: %q", gotQuery)
	}
	// Body must be one JSON object per line.
	lines := strings.Split(strings.TrimSpace(gotBody), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 JSONEachRow lines, got %d: %q", len(lines), gotBody)
	}
	if !strings.Contains(lines[0], `"dim_value":"gpt-4.1"`) || !strings.Contains(lines[0], `"requests":10`) {
		t.Errorf("unexpected first line: %q", lines[0])
	}

	// No URL → disabled (error, no panic).
	if _, err := clickhouseSink(context.Background(), http.DefaultClient, config.ClickHouseConfig{}, rows); err == nil {
		t.Error("expected error when URL not configured")
	}
}
