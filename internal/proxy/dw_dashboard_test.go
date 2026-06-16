package proxy

import (
	"context"
	"encoding/json"
	"io"
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

func TestDWDashboardText2SQLDisabled(t *testing.T) {
	// ClickHouse configured but no Text2SQL fact table → configured:false.
	srv := newDWTestServer(t, "http://ch.invalid")
	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/text2sql")
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out["configured"] != false {
		t.Fatalf("expected configured=false without fact table, got %+v", out)
	}
}

func TestDWDashboardText2SQL(t *testing.T) {
	// One CH stub answers the 3 queries by inspecting the SQL.
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(q, "GROUP BY mode"):
			_, _ = w.Write([]byte(`{"data":[{"mode":"preview","n":"60","executed":"0"},{"mode":"execute","n":"40","executed":"38"}]}`))
		case strings.Contains(q, "failure_category != ''"):
			_, _ = w.Write([]byte(`{"data":[{"reason":"invalid_sql","n":"5"}]}`))
		default:
			_, _ = w.Write([]byte(`{"data":[{"total":"100","valid":"90","executed":"38","blocked":"7","avg_risk":2.5,"cost_krw":4200}]}`))
		}
	}))
	defer ch.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "t2s.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.chRuntime.Store(&config.ClickHouseConfig{URL: ch.URL, Table: "ai_request_rollup", Text2SQLFactTable: "text2sql_fact"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/text2sql?window=7d")
	var out struct {
		Configured bool             `json:"configured"`
		Total      float64          `json:"total"`
		Blocked    float64          `json:"blocked"`
		BlockRate  float64          `json:"block_rate"`
		ByMode     []map[string]any `json:"by_mode"`
		Failures   []map[string]any `json:"failures"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if !out.Configured || out.Total != 100 || out.Blocked != 7 {
		t.Fatalf("summary wrong: %+v", out)
	}
	if out.BlockRate < 0.069 || out.BlockRate > 0.071 {
		t.Fatalf("block_rate = %v, want ~0.07", out.BlockRate)
	}
	if len(out.ByMode) != 2 || len(out.Failures) != 1 {
		t.Fatalf("by_mode/failures wrong: %+v / %+v", out.ByMode, out.Failures)
	}
}

func TestDWDashboardRouting(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(q, "GROUP BY requested_model"):
			_, _ = w.Write([]byte(`{"data":[{"from_model":"auto","to_model":"qwen-plus","n":"30"}]}`))
		case strings.Contains(q, "decision_reason != ''"):
			_, _ = w.Write([]byte(`{"data":[{"reason":"complexity_rule","n":"25"}]}`))
		default:
			_, _ = w.Write([]byte(`{"data":[{"total":"100","auto_routed":"40","fallback_used":"6","avg_complexity":3.2,"avg_risk":1.1,"avg_health":95}]}`))
		}
	}))
	defer ch.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "rt.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.chRuntime.Store(&config.ClickHouseConfig{URL: ch.URL, Table: "ai_request_rollup", RoutingFactTable: "ai_routing_fact"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/routing?window=7d")
	var out struct {
		Configured    bool             `json:"configured"`
		Total         float64          `json:"total"`
		AutoRouted    float64          `json:"auto_routed"`
		AutoRouteRate float64          `json:"auto_route_rate"`
		Rewrites      []map[string]any `json:"rewrites"`
		Reasons       []map[string]any `json:"reasons"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if !out.Configured || out.Total != 100 || out.AutoRouted != 40 {
		t.Fatalf("routing summary wrong: %+v", out)
	}
	if out.AutoRouteRate < 0.39 || out.AutoRouteRate > 0.41 {
		t.Fatalf("auto_route_rate = %v, want ~0.40", out.AutoRouteRate)
	}
	if len(out.Rewrites) != 1 || len(out.Reasons) != 1 {
		t.Fatalf("rewrites/reasons wrong: %+v / %+v", out.Rewrites, out.Reasons)
	}

	// Unconfigured routing fact → configured:false.
	srv2 := newDWTestServer(t, "http://ch.invalid")
	r2, _ := http.Get(srv2.URL + "/admin/dw/dashboard/routing")
	var o2 map[string]any
	json.NewDecoder(r2.Body).Decode(&o2)
	r2.Body.Close()
	if o2["configured"] != false {
		t.Fatalf("expected configured=false without routing fact, got %+v", o2)
	}
}

func TestDWDashboardLatency(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(q, "GROUP BY model"):
			_, _ = w.Write([]byte(`{"data":[{"model":"gpt-4o","n":"80","p95":1800,"errors":"2"}]}`))
		default:
			_, _ = w.Write([]byte(`{"data":[{"total":"100","p50":420,"p95":1800,"p99":3200,"avg_ms":650,"max_ms":5000,"ttfb_p95":300,"streamed":"60","errors":"4"}]}`))
		}
	}))
	defer ch.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "lat.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.chRuntime.Store(&config.ClickHouseConfig{URL: ch.URL, Table: "ai_request_rollup", RequestFactTable: "ai_request_fact"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/latency?window=7d&model=gpt-4o")
	var out struct {
		Configured  bool             `json:"configured"`
		Total       float64          `json:"total"`
		P95MS       float64          `json:"p95_ms"`
		ErrorRate   float64          `json:"error_rate"`
		StreamShare float64          `json:"stream_share"`
		ByModel     []map[string]any `json:"by_model"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if !out.Configured || out.Total != 100 || out.P95MS != 1800 {
		t.Fatalf("latency summary wrong: %+v", out)
	}
	if out.ErrorRate < 0.039 || out.ErrorRate > 0.041 {
		t.Fatalf("error_rate = %v, want ~0.04", out.ErrorRate)
	}
	if out.StreamShare < 0.59 || out.StreamShare > 0.61 {
		t.Fatalf("stream_share = %v, want ~0.60", out.StreamShare)
	}
	if len(out.ByModel) != 1 {
		t.Fatalf("by_model wrong: %+v", out.ByModel)
	}

	// Unconfigured request fact → configured:false.
	srv2 := newDWTestServer(t, "http://ch.invalid")
	r2, _ := http.Get(srv2.URL + "/admin/dw/dashboard/latency")
	var o2 map[string]any
	json.NewDecoder(r2.Body).Decode(&o2)
	r2.Body.Close()
	if o2["configured"] != false {
		t.Fatalf("expected configured=false without request fact, got %+v", o2)
	}
}

func TestDWDashboardQuality(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(q, "GROUP BY category"):
			_, _ = w.Write([]byte(`{"data":[{"category":"security","n":"50","avg_score":0.9,"passed":"48"}]}`))
		case strings.Contains(q, "label != ''"):
			_, _ = w.Write([]byte(`{"data":[{"label":"good","n":"30"},{"label":"bad","n":"10"}]}`))
		case strings.Contains(q, "avg(rating)"):
			_, _ = w.Write([]byte(`{"data":[{"total":"40","avg_rating":0.5,"positive":"30","negative":"10"}]}`))
		default: // eval summary
			_, _ = w.Write([]byte(`{"data":[{"total":"100","avg_score":0.85,"passed":"90"}]}`))
		}
	}))
	defer ch.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "qual.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.chRuntime.Store(&config.ClickHouseConfig{URL: ch.URL, Table: "ai_request_rollup", EvalFactTable: "ai_eval_fact", FeedbackFactTable: "ai_feedback_fact"})
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/quality?window=7d")
	var out struct {
		Configured bool `json:"configured"`
		Eval       struct {
			Configured bool             `json:"configured"`
			Total      float64          `json:"total"`
			PassRate   float64          `json:"pass_rate"`
			ByCategory []map[string]any `json:"by_category"`
		} `json:"eval"`
		Feedback struct {
			Configured   bool             `json:"configured"`
			Total        float64          `json:"total"`
			PositiveRate float64          `json:"positive_rate"`
			ByLabel      []map[string]any `json:"by_label"`
		} `json:"feedback"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if !out.Configured || !out.Eval.Configured || out.Eval.Total != 100 {
		t.Fatalf("eval summary wrong: %+v", out)
	}
	if out.Eval.PassRate < 0.89 || out.Eval.PassRate > 0.91 {
		t.Fatalf("pass_rate = %v, want ~0.90", out.Eval.PassRate)
	}
	if !out.Feedback.Configured || out.Feedback.Total != 40 || len(out.Feedback.ByLabel) != 2 {
		t.Fatalf("feedback wrong: %+v", out.Feedback)
	}
	if out.Feedback.PositiveRate < 0.74 || out.Feedback.PositiveRate > 0.76 {
		t.Fatalf("positive_rate = %v, want ~0.75", out.Feedback.PositiveRate)
	}

	// Neither fact configured → configured:false.
	srv2 := newDWTestServer(t, "http://ch.invalid")
	r2, _ := http.Get(srv2.URL + "/admin/dw/dashboard/quality")
	var o2 map[string]any
	json.NewDecoder(r2.Body).Decode(&o2)
	r2.Body.Close()
	if o2["configured"] != false {
		t.Fatalf("expected configured=false without eval/feedback facts, got %+v", o2)
	}
}

func TestDWDashboardExportCSV(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"dim_value":"gpt-4o","requests":"80","tokens":"4000","cost_krw":900,"errors":"1"}]}`))
	}))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)

	resp, _ := http.Get(srv.URL + "/admin/dw/dashboard/export.csv?dimension=model&order_by=cost")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("content-type = %s", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	// UTF-8 BOM + header + data row.
	if len(body) < 3 || body[0] != 0xEF || body[1] != 0xBB || body[2] != 0xBF {
		t.Fatal("missing UTF-8 BOM")
	}
	text := string(body[3:])
	if !strings.Contains(text, "model,requests,tokens,cost_krw,errors") || !strings.Contains(text, "gpt-4o,80,4000,900.00,1") {
		t.Fatalf("csv content wrong: %q", text)
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
