package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// fakeClickHouse records DDL/exec statements (POST body) and answers read queries (GET).
func fakeClickHouse() (*httptest.Server, *[]string) {
	var mu sync.Mutex
	stmts := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		if r.Method == http.MethodPost && q == "" {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			stmts = append(stmts, string(body))
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		switch {
		case strings.Contains(q, "system.tables"):
			_, _ = w.Write([]byte("ReplacingMergeTree\tday, dimension, dim_value\n"))
		case strings.HasPrefix(q, "EXISTS TABLE"):
			_, _ = w.Write([]byte("1\n"))
		default: // SELECT 1 and friends
			_, _ = w.Write([]byte("1\n"))
		}
	}))
	return srv, &stmts
}

func TestClickHouseManualSinkRollsUpFirst(t *testing.T) {
	ch, _ := fakeClickHouse()
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	// A request today, but no rollup computed yet (no worker has run).
	now := time.Now().UTC()
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{ID: "req1", TraceID: "req1", Endpoint: "/v1/chat/completions", Model: "gpt-4.1", StatusCode: 200, CreatedAt: now},
		Usage:   &store.TokenUsage{ID: "u1", RequestID: "req1", TotalTokens: 10, Currency: "KRW", Source: "usage", CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.Table = "daily_rollups"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Post(proxy.URL+"/admin/dw/clickhouse?days=1", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		SentRows int `json:"sent_rows"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.SentRows < 1 {
		t.Fatalf("manual sink should roll up the window first and ship >=1 row, got %d", out.SentRows)
	}
}

func TestClickHouseBootstrapCreatesMaterializedViews(t *testing.T) {
	ch, stmts := fakeClickHouse()
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.Database = "ai_gateway"
	cfg.ClickHouse.Table = "analytics_daily"
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Post(proxy.URL+"/admin/dw/clickhouse/bootstrap", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	joined := strings.Join(*stmts, "\n")
	if !strings.Contains(joined, "ai_request_fact_daily") || !strings.Contains(joined, "ai_request_fact_hourly") {
		t.Errorf("expected daily+hourly aggregate tables, got: %s", joined)
	}
	if !strings.Contains(joined, "MATERIALIZED VIEW") || !strings.Contains(joined, "toStartOfHour(event_time)") {
		t.Errorf("expected materialized views (daily+hourly), got: %s", joined)
	}
	if !strings.Contains(joined, "SummingMergeTree") {
		t.Errorf("expected SummingMergeTree aggregate engine, got: %s", joined)
	}
}

func TestClickHouseBootstrapAndOverview(t *testing.T) {
	ch, stmts := fakeClickHouse()
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.Database = "ai_gateway"
	cfg.ClickHouse.Table = "daily_rollups"

	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Bootstrap: creates the database + rollup table.
	bResp, err := http.Post(proxy.URL+"/admin/dw/clickhouse/bootstrap", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bResp.Body.Close()
	var boot struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Object string `json:"object"`
			OK     bool   `json:"ok"`
		} `json:"steps"`
	}
	if err := json.NewDecoder(bResp.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	if !boot.OK || len(boot.Steps) < 2 {
		t.Fatalf("bootstrap not ok: %+v", boot)
	}
	joined := strings.Join(*stmts, "\n")
	if !strings.Contains(joined, "CREATE DATABASE IF NOT EXISTS ai_gateway") {
		t.Errorf("expected CREATE DATABASE, got: %s", joined)
	}
	if !strings.Contains(joined, "CREATE TABLE IF NOT EXISTS ai_gateway.daily_rollups") || !strings.Contains(joined, "ReplacingMergeTree") {
		t.Errorf("expected rollup table DDL, got: %s", joined)
	}

	// Overview: configured + ping ok + rollup table present + auto-sink off (interval 0).
	oResp, err := http.Get(proxy.URL + "/admin/dw/clickhouse/overview")
	if err != nil {
		t.Fatal(err)
	}
	defer oResp.Body.Close()
	var ov map[string]any
	if err := json.NewDecoder(oResp.Body).Decode(&ov); err != nil {
		t.Fatal(err)
	}
	if ov["configured"] != true {
		t.Fatalf("expected configured=true, got %+v", ov)
	}
	if ping, _ := ov["ping"].(map[string]any); ping["ok"] != true {
		t.Fatalf("expected ping ok, got %+v", ov["ping"])
	}
	if rt, _ := ov["rollup_table"].(map[string]any); rt["exists"] != true || rt["dedupe_ok"] != true {
		t.Fatalf("expected rollup table exists+dedupe_ok, got %+v", ov["rollup_table"])
	}
	if sink, _ := ov["sink"].(map[string]any); sink["auto_enabled"] != false {
		t.Fatalf("expected auto_enabled false (interval 0), got %+v", ov["sink"])
	}
}
