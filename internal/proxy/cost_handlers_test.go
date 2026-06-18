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
	"time"

	"vibe-coders/internal/store"
)

// costTestServer seeds nothing; callers seed via the returned db then hit the httptest server.
func costTestServer(t *testing.T) (*store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "cost.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	t.Cleanup(srv.Close)
	return db, srv
}

func seedCostCenterReq(t *testing.T, db *store.SQLStore, id, costCenter, project, model string, status int, failover bool, tokens int, cost float64, when time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
			Model: model, Provider: "openai", StatusCode: status, Failover: failover,
			Project: project, CostCenter: costCenter, CreatedAt: when},
		Usage: &store.TokenUsage{ID: id + "_u", RequestID: id, PromptTokens: tokens, TotalTokens: tokens,
			EstimatedCost: cost, Currency: "KRW", CreatedAt: when},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestInvoicesHandler(t *testing.T) {
	db, srv := costTestServer(t)
	now := time.Now().UTC()
	seedCostCenterReq(t, db, "i1", "cc-eng", "p", "gpt-4.1", 200, false, 100, 10, now)
	seedCostCenterReq(t, db, "i2", "cc-eng", "p", "gpt-4.1", 200, false, 100, 10, now)
	seedCostCenterReq(t, db, "i3", "cc-eng", "p", "gpt-4.1-mini", 200, false, 50, 2, now)
	seedCostCenterReq(t, db, "i4", "cc-sales", "p", "gpt-4.1", 200, false, 30, 3, now)

	// Summary mode: list cost centers.
	resp, err := http.Get(srv.URL + "/admin/invoices?window=7d")
	if err != nil {
		t.Fatal(err)
	}
	var summary struct {
		CostCenters []map[string]any `json:"cost_centers"`
	}
	json.NewDecoder(resp.Body).Decode(&summary)
	resp.Body.Close()
	if len(summary.CostCenters) != 2 {
		t.Fatalf("expected 2 cost centers, got %+v", summary.CostCenters)
	}

	// Detail mode: one cost center's invoice.
	resp2, err := http.Get(srv.URL + "/admin/invoices?cost_center=cc-eng&window=7d")
	if err != nil {
		t.Fatal(err)
	}
	var inv struct {
		CostCenter    string  `json:"cost_center"`
		TotalRequests int64   `json:"total_requests"`
		TotalCostKRW  float64 `json:"total_cost_krw"`
		LineItems     []struct {
			Model   string  `json:"model"`
			CostKRW float64 `json:"cost_krw"`
		} `json:"line_items"`
	}
	json.NewDecoder(resp2.Body).Decode(&inv)
	resp2.Body.Close()
	if inv.CostCenter != "cc-eng" || inv.TotalRequests != 3 {
		t.Fatalf("invoice wrong: %+v", inv)
	}
	if inv.TotalCostKRW < 21.99 || inv.TotalCostKRW > 22.01 {
		t.Errorf("total cost = %f, want ~22", inv.TotalCostKRW)
	}
	if len(inv.LineItems) != 2 {
		t.Errorf("expected 2 model line items, got %d", len(inv.LineItems))
	}

	// Markdown format.
	resp3, err := http.Get(srv.URL + "/admin/invoices?cost_center=cc-eng&format=markdown")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp3.Body)
	resp3.Body.Close()
	if ct := resp3.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") {
		t.Errorf("content-type = %s, want markdown", ct)
	}
	if !strings.Contains(string(body), "청구서") || !strings.Contains(string(body), "cc-eng") {
		t.Errorf("markdown invoice missing expected content: %s", body)
	}
}

func TestCostAllocationHandler(t *testing.T) {
	db, srv := costTestServer(t)
	now := time.Now().UTC()
	seedCostCenterReq(t, db, "a1", "cc-eng", "proj-x", "gpt-4.1", 200, false, 100, 10, now)
	seedCostCenterReq(t, db, "a2", "cc-eng", "proj-x", "gpt-4.1", 200, false, 100, 10, now)
	seedCostCenterReq(t, db, "a3", "cc-sales", "proj-y", "gpt-4.1", 500, false, 100, 5, now)

	resp, err := http.Get(srv.URL + "/admin/cost/allocation?dimension=cost_center&window=7d")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Dimension string           `json:"dimension"`
		Rows      []map[string]any `json:"rows"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Dimension != "cost_center" || len(out.Rows) != 2 {
		t.Fatalf("allocation wrong: %+v", out)
	}

	// Invalid dimension → 400.
	bad, _ := http.Get(srv.URL + "/admin/cost/allocation?dimension=nonsense")
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid dimension should be 400, got %d", bad.StatusCode)
	}
	bad.Body.Close()
}

func TestInsuranceClaimsHandler(t *testing.T) {
	db, srv := costTestServer(t)
	now := time.Now().UTC()
	// project "alpha": 10 covered requests, 3 degraded (5xx, 4xx, failover).
	for i := 0; i < 7; i++ {
		seedCostCenterReq(t, db, "ok-"+itoaT(i), "cc", "alpha", "gpt-4.1", 200, false, 10, 1, now)
	}
	seedCostCenterReq(t, db, "e500", "cc", "alpha", "gpt-4.1", 500, false, 10, 1, now)
	seedCostCenterReq(t, db, "e400", "cc", "alpha", "gpt-4.1", 400, false, 10, 1, now)
	seedCostCenterReq(t, db, "efo", "cc", "alpha", "gpt-4.1", 200, true, 10, 1, now)

	resp, err := http.Get(srv.URL + "/admin/insurance/claims?dimension=project&sla=0.99&window=7d")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Dimension      string `json:"dimension"`
		TotalCovered   int64  `json:"total_covered"`
		TotalClaims    int64  `json:"total_claims"`
		ScopesInBreach int    `json:"scopes_in_breach"`
		Scopes         []struct {
			Scope  string `json:"scope"`
			Claims int64  `json:"claims"`
			SLAMet bool   `json:"sla_met"`
		} `json:"scopes"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.TotalCovered != 10 {
		t.Fatalf("total_covered = %d, want 10", out.TotalCovered)
	}
	if out.TotalClaims != 3 {
		t.Fatalf("total_claims = %d, want 3 (5xx+4xx+failover)", out.TotalClaims)
	}
	if out.ScopesInBreach < 1 {
		t.Errorf("expected alpha to breach 0.99 SLA with 3/10 claims, got %d in breach", out.ScopesInBreach)
	}
}
