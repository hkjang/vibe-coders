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
