package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func newDWTestServer(t *testing.T, chURL string) *httptest.Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "dw.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if chURL != "" {
		server.chRuntime.Store(&config.ClickHouseConfig{URL: chURL, Table: "ai_request_rollup"})
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	return srv
}

func TestDWDashboardDisabledWhenUnconfigured(t *testing.T) {
	srv := newDWTestServer(t, "")
	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/overview")
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out["configured"] != false {
		t.Fatalf("expected configured=false, got %+v", out)
	}
}

func TestDWDashboardOverview(t *testing.T) {
	var sawQuery string
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawQuery = r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		// ClickHouse returns UInt64 as strings, Float64 as numbers.
		_, _ = w.Write([]byte(`{"data":[{"requests":"100","tokens":"5000","cost_krw":1234.5,"errors":"3"}]}`))
	}))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/overview?window=7d&model=gpt-4o")
	var out struct {
		Configured        bool    `json:"configured"`
		Requests          float64 `json:"requests"`
		Errors            float64 `json:"errors"`
		ErrorRate         float64 `json:"error_rate"`
		CostPerRequestKRW float64 `json:"cost_per_request_krw"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if !out.Configured || out.Requests != 100 || out.Errors != 3 {
		t.Fatalf("overview parse wrong: %+v", out)
	}
	if out.ErrorRate < 0.029 || out.ErrorRate > 0.031 {
		t.Fatalf("error_rate = %v, want ~0.03", out.ErrorRate)
	}
	// A model filter must scope to the model dimension, not the global 'all'.
	if !strings.Contains(sawQuery, "dimension = 'model'") || !strings.Contains(sawQuery, "dim_value = 'gpt-4o'") {
		t.Fatalf("query did not scope to model dimension: %s", sawQuery)
	}
	if !strings.Contains(sawQuery, "FORMAT JSON") {
		t.Fatalf("query missing FORMAT JSON: %s", sawQuery)
	}
}

func TestDWDashboardDimensionsValidation(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"dim_value":"gpt-4o","requests":"80","tokens":"4000","cost_krw":900,"errors":"1"}]}`))
	}))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)

	// invalid dimension → 400
	bad, _ := http.Get(srv.URL + "/admin/dw/dashboard/dimensions?dimension=all")
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("dimension=all should be 400, got %d", bad.StatusCode)
	}
	bad.Body.Close()

	ok, _ := http.Get(srv.URL + "/admin/dw/dashboard/dimensions?dimension=model&order_by=cost")
	var out struct {
		Rows []map[string]any `json:"rows"`
	}
	json.NewDecoder(ok.Body).Decode(&out)
	ok.Body.Close()
	if len(out.Rows) != 1 || out.Rows[0]["value"] != "gpt-4o" {
		t.Fatalf("dimensions rows wrong: %+v", out.Rows)
	}
}
