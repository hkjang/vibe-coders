package proxy

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Explicit local-only fixture. CI runs this inside a fresh network-isolated
// ClickHouse container; no credentials or production endpoint are accepted.
func TestDWDashboardClickHouseDateSelection(t *testing.T) {
	if os.Getenv("VIBE_TEST_DW_CLICKHOUSE_LOCAL") != "1" {
		t.Skip("opt in with a fresh local ClickHouse fixture")
	}
	const endpoint = "http://127.0.0.1:8123"
	client := &http.Client{Timeout: 10 * time.Second}
	execute := func(query string) {
		t.Helper()
		response, err := client.Post(endpoint, "text/plain", strings.NewReader(query))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("fixture query: %d %s", response.StatusCode, body)
		}
	}
	// Do not drop an existing table: accidental reuse must fail closed.
	execute("CREATE TABLE ai_request_rollup (day Date, dimension String, dim_value String, requests UInt64, tokens UInt64, cost_krw Float64, errors UInt64) ENGINE=ReplacingMergeTree ORDER BY (day, dimension, dim_value)")
	t.Cleanup(func() { execute("DROP TABLE ai_request_rollup") })
	execute("INSERT INTO ai_request_rollup VALUES ('2024-02-28','model','before',1000,1000,1000,0),('2024-02-29','model','selected',3,5,7,1),('2024-03-01','model','selected',11,13,17,2),('2024-03-02','model','after',1000,1000,1000,0),('1970-01-01','model','minimum',19,19,19,0),('2149-06-06','model','maximum',23,23,23,0)")
	srv := newDWTestServer(t, endpoint)
	read := func(path, query string) []byte {
		t.Helper()
		response, err := client.Get(srv.URL + "/admin/dw/dashboard/" + path + "?dimension=model&order_by=cost&limit=10&" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("read status %d: %s", response.StatusCode, body)
		}
		return body
	}
	for _, fixture := range []struct {
		name, since, until, value string
		requests                  float64
	}{
		{"leap-day", "2024-02-29", "2024-03-01", "selected", 3},
		{"exclusive-end", "2024-02-29", "2024-03-02", "selected", 14},
		{"different-cache-range", "2024-03-01", "2024-03-02", "selected", 11},
		{"minimum-date", "1970-01-01", "1970-01-02", "minimum", 19},
		{"maximum-date", "2149-06-06", "2149-06-07", "maximum", 23},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			query := "window=7d&since_day=" + fixture.since + "&until_day=" + fixture.until
			var out struct {
				Since string `json:"since"`
				Until string `json:"until"`
				Rows  []struct {
					Value    string  `json:"value"`
					Requests float64 `json:"requests"`
				} `json:"rows"`
			}
			if err := json.Unmarshal(read("dimensions", query), &out); err != nil {
				t.Fatal(err)
			}
			if out.Since != fixture.since || out.Until != fixture.until || len(out.Rows) != 1 || out.Rows[0].Value != fixture.value || out.Rows[0].Requests != fixture.requests {
				t.Fatalf("unexpected bounded aggregate: %+v", out)
			}
			csvBody := strings.TrimPrefix(string(read("export.csv", query)), "\ufeff")
			records, err := csv.NewReader(strings.NewReader(csvBody)).ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			if len(records) != 2 || records[1][0] != fixture.value || records[1][1] != strconv.FormatFloat(fixture.requests, 'f', 0, 64) {
				t.Fatalf("CSV disagrees with selected JSON: %v", records)
			}
		})
	}
	// Actual toMonday grouping and the initial partial week: rows before since
	// must not re-enter when the UI drills into the first weekly point.
	since, _ := dwSinceDate(mustDWRequest(t, srv.URL+"?window=7d"))
	start, _ := time.Parse(time.DateOnly, since)
	before := start.AddDate(0, 0, -1).Format(time.DateOnly)
	execute("INSERT INTO ai_request_rollup VALUES ('" + before + "','all','',1000,1000,1000,0),('" + since + "','all','',29,29,29,0),('" + since + "','model','current',29,29,29,0)")
	var series struct {
		Since  string `json:"since"`
		Bucket string `json:"bucket"`
		Points []struct {
			Day      string  `json:"day"`
			Requests float64 `json:"requests"`
		} `json:"points"`
	}
	if err := json.Unmarshal(read("timeseries", "window=7d&bucket=week"), &series); err != nil {
		t.Fatal(err)
	}
	if len(series.Points) != 1 || series.Points[0].Requests != 29 || series.Since != since || series.Bucket != "week" {
		t.Fatalf("weekly series widened the window: %+v", series)
	}
	monday, err := time.Parse(time.DateOnly, series.Points[0].Day)
	if err != nil {
		t.Fatal(err)
	}
	if monday.Weekday() != time.Monday {
		t.Fatal("weekly point is not Monday")
	}
	until := monday.AddDate(0, 0, 7).Format(time.DateOnly)
	var selected struct {
		Rows []struct {
			Requests float64 `json:"requests"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(read("dimensions", "since_day="+since+"&until_day="+until), &selected); err != nil {
		t.Fatal(err)
	}
	if len(selected.Rows) != 1 || selected.Rows[0].Requests != series.Points[0].Requests {
		t.Fatalf("first partial week disagrees: %+v", selected)
	}
}

func mustDWRequest(t *testing.T, target string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
