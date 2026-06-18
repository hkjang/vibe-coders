package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestBudgetAlerts(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "ba.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// A budget with no spend → "ok": absent from default alerts, present with ?all=1.
	resp := postJSON(t, proxy.URL+"/admin/budgets", "", map[string]any{"scope": "global", "monthly_krw": 100000})
	resp.Body.Close()

	def, _ := http.Get(proxy.URL + "/admin/budgets/alerts")
	var d struct {
		Alerts   []map[string]any `json:"alerts"`
		Warn     int              `json:"warn"`
		Critical int              `json:"critical"`
	}
	json.NewDecoder(def.Body).Decode(&d)
	def.Body.Close()
	if len(d.Alerts) != 0 || d.Warn != 0 || d.Critical != 0 {
		t.Fatalf("no-spend budget should raise no alerts, got %+v", d)
	}

	all, _ := http.Get(proxy.URL + "/admin/budgets/alerts?all=1")
	var a struct {
		Alerts []map[string]any `json:"alerts"`
	}
	json.NewDecoder(all.Body).Decode(&a)
	all.Body.Close()
	if len(a.Alerts) != 1 || a.Alerts[0]["severity"] != "ok" {
		t.Fatalf("all=1 should include the ok budget, got %+v", a.Alerts)
	}
}

func TestAdminBudgetsCRUD(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// create
	resp := postJSON(t, proxy.URL+"/admin/budgets", "", map[string]any{
		"scope": "global", "monthly_krw": 50000, "note": "전체 월예산",
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	// list with status forecast
	listResp, err := http.Get(proxy.URL + "/admin/budgets")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	var listed struct {
		Budgets []struct {
			Budget         store.Budget `json:"budget"`
			SpentKRW       float64      `json:"spent_krw"`
			ProjectedRatio float64      `json:"projected_ratio"`
			OnTrack        bool         `json:"on_track"`
		} `json:"budgets"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Budgets) != 1 {
		t.Fatalf("want 1 budget, got %d", len(listed.Budgets))
	}
	if listed.Budgets[0].Budget.MonthlyKRW != 50000 || listed.Budgets[0].Budget.ScopeValue != "*" {
		t.Fatalf("unexpected budget: %+v", listed.Budgets[0].Budget)
	}

	// invalid scope rejected
	bad := postJSON(t, proxy.URL+"/admin/budgets", "", map[string]any{"scope": "nope", "monthly_krw": 100})
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad scope, got %d", bad.StatusCode)
	}
	bad.Body.Close()

	// non-positive budget rejected
	zero := postJSON(t, proxy.URL+"/admin/budgets", "", map[string]any{"scope": "global", "monthly_krw": 0})
	if zero.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for zero budget, got %d", zero.StatusCode)
	}
	zero.Body.Close()

	// delete
	id := listed.Budgets[0].Budget.ID
	req, _ := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/budgets/"+id, nil)
	delResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("delete failed: %d", delResp.StatusCode)
	}
	delResp.Body.Close()

	budgets, err := db.ListBudgets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(budgets) != 0 {
		t.Fatalf("expected no budgets after delete, got %d", len(budgets))
	}
}
