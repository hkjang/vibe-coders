package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestDWDashboardSelectedDateBounds(t *testing.T) {
	var mu sync.Mutex
	queries := []string{}
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.Query().Get("query"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"dim_value":"model-a","requests":"3","tokens":"7","cost_krw":12,"errors":"1"}]}`)
	}))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)
	for _, path := range []string{"dimensions", "export.csv"} {
		t.Run(path, func(t *testing.T) {
			response, err := http.Get(srv.URL + "/admin/dw/dashboard/" + path + "?dimension=model&window=90d&since_day=2024-02-29&until_day=2024-03-02")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status %d", response.StatusCode)
			}
			if path == "dimensions" {
				var out struct {
					Since string `json:"since"`
					Until string `json:"until"`
				}
				if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
					t.Fatal(err)
				}
				if out.Since != "2024-02-29" || out.Until != "2024-03-02" {
					t.Fatalf("bounds not echoed: %+v", out)
				}
			} else {
				body, _ := io.ReadAll(response.Body)
				if !strings.Contains(string(body), "model-a,3,7,12.00,1") {
					t.Fatal("selected export changed row values")
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(queries) == 0 {
				t.Fatal("expected a rollup read")
			}
			query := queries[len(queries)-1]
			if !strings.Contains(query, "day >= '2024-02-29' AND day <= '2024-03-01'") || !strings.Contains(query, "dimension = 'model'") {
				t.Fatalf("selected period not applied: %s", query)
			}
		})
	}
}

func TestDWDashboardRejectsInvalidDateBoundsBeforeQuery(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)
	for _, bounds := range []string{
		"since_day=2024-02-29", "until_day=2024-03-01", "since_day=&until_day=",
		"since_day=2023-02-29&until_day=2023-03-01", "since_day=2024-03-01&until_day=2024-03-01",
		"since_day=2024-03-02&until_day=2024-03-01", "since_day=2024-01-01&until_day=2024-04-01",
		"since_day=2024-02-01&since_day=2024-02-02&until_day=2024-02-03",
		"since_day=2024-02-01&until_day=2024-02-03&until_day=2024-02-04",
		"since_day=2024-02-01%27%20OR%201=1--&until_day=2024-02-03",
		"since_day=1969-12-31&until_day=1970-01-01", "since_day=2149-06-06&until_day=2149-06-08",
	} {
		for _, path := range []string{"dimensions", "export.csv"} {
			t.Run(path+"/"+bounds, func(t *testing.T) {
				response, err := http.Get(srv.URL + "/admin/dw/dashboard/" + path + "?dimension=model&" + bounds)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				if response.StatusCode != http.StatusBadRequest {
					t.Fatalf("invalid range must not broaden to the window: status %d", response.StatusCode)
				}
			})
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 0 {
		t.Fatalf("invalid bounds reached ClickHouse %d times", calls)
	}
}

func TestDWDashboardDateBoundsCapability(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"data":[]}`) }))
	defer ch.Close()
	srv := newDWTestServer(t, ch.URL)
	response, err := http.Get(srv.URL + "/admin/dw/dashboard/timeseries?window=7d&bucket=week")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var out struct {
		Supported bool `json:"date_bounds_supported"`
	}
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Supported {
		t.Fatal("new UI cannot distinguish a server that ignores date selection")
	}
}
