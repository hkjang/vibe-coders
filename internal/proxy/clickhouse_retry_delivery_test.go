package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestClickHouseRetryPreservesUnsentAndConcurrentWork(t *testing.T) {
	for _, scenario := range []string{"rollup_control", "text2sql_fact", "text2sql_fact_tied", "redteam_fact", "new_failure_during_send", "rollup_over_5000"} {
		t.Run(scenario, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fixture.db")
			db := openSQLiteTestStore(t, path)
			raw, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			now := time.Now().UTC()
			since := now.AddDate(0, 0, -1).Format("2006-01-02")
			dim := "model"
			expected := int64(1)
			if strings.HasPrefix(scenario, "text2sql_fact") {
				dim = "text2sql_fact"
				if scenario == "text2sql_fact_tied" {
					expected = 2001
				}
				for i := int64(0); i < expected; i++ {
					if err := db.InsertText2SQLLog(t.Context(), store.Text2SQLQueryLog{ID: fmt.Sprintf("fact-%05d", i), RequestID: fmt.Sprintf("request-%05d", i), Mode: "execute", CreatedAt: now, Question: "private synthetic question", GeneratedSQL: "SELECT 'synthetic private sql'"}); err != nil {
						t.Fatal(err)
					}
				}
			} else if scenario == "redteam_fact" {
				dim = "redteam_fact"
				expected = 1001
				if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "model:fixture", Enabled: true}}); err != nil {
					t.Fatal(err)
				}
				if err := db.UpsertRedTeamCampaign(t.Context(), store.RedTeamCampaign{ID: "campaign", Name: "fixture"}); err != nil {
					t.Fatal(err)
				}
				if err := db.InsertRedTeamRun(t.Context(), store.RedTeamRun{ID: "run", CampaignID: "campaign", TargetID: "target"}); err != nil {
					t.Fatal(err)
				}
				for i := int64(0); i < expected; i++ {
					if err := db.InsertRedTeamCaseResult(t.Context(), store.RedTeamCaseResult{ID: fmt.Sprintf("case-%05d", i), RunID: "run", Decision: "pass", Severity: "info", CreatedAt: now.Format(time.RFC3339Nano)}); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				if scenario == "rollup_over_5000" {
					expected = 5001
				}
				tx, err := raw.BeginTx(t.Context(), nil)
				if err != nil {
					t.Fatal(err)
				}
				for i := int64(0); i < expected; i++ {
					_, err = tx.ExecContext(t.Context(), `INSERT INTO analytics_daily(day,dimension,dim_value,requests,tokens,cost_krw,errors) VALUES(?,?,?,?,?,?,?)`, since, dim, fmt.Sprintf("model-%05d", i), 1, 1, 1, 0)
					if err != nil {
						t.Fatal(err)
					}
				}
				if err := tx.Commit(); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.RecordClickHouseSinkFailure(t.Context(), dim, since, "fixture initial failure"); err != nil {
				t.Fatal(err)
			}
			var sent atomic.Int64
			var newFailure atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Query().Get("query"), "INSERT INTO ") {
					t.Error("unexpected upstream request")
					w.WriteHeader(400)
					return
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					w.WriteHeader(500)
					return
				}
				if strings.Contains(string(body), "private synthetic") || strings.Contains(string(body), "synthetic private sql") {
					t.Error("raw source content reached the analytics sink")
				}
				if strings.HasSuffix(dim, "_fact") && !strings.Contains(r.URL.Query().Get("query"), dim) {
					t.Error("wrong fact destination")
				}
				trimmed := strings.TrimSpace(string(body))
				if trimmed != "" {
					sent.Add(int64(len(strings.Split(trimmed, "\n"))))
				}
				if scenario == "new_failure_during_send" {
					if err := db.RecordClickHouseSinkFailure(context.Background(), dim, since, "fixture concurrent newer failure"); err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					newFailure.Store(true)
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer upstream.Close()
			cfg := testConfig("http://upstream.invalid", "synthetic-key")
			cfg.ClickHouse.URL = upstream.URL
			cfg.ClickHouse.Table = "daily_rollups"
			cfg.ClickHouse.Text2SQLFactTable = "text2sql_fact"
			cfg.ClickHouse.RedTeamFactTable = "redteam_fact"
			server, err := NewServer(cfg, db, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			gateway := httptest.NewServer(server.Routes())
			defer gateway.Close()
			response, err := http.Post(gateway.URL+"/admin/dw/sink-retry", "application/json", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var result struct {
				Recovered int               `json:"recovered_dimensions"`
				Sent      int               `json:"sent_rows"`
				Failed    map[string]string `json:"failed"`
			}
			if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			retries, err := db.ListClickHouseSinkRetries(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("scenario=%s HTTP=%d reported_recovered=%d reported_sent=%d actual_sent=%d expected=%d retained_retries=%d concurrent_failure_recorded=%t", scenario, response.StatusCode, result.Recovered, result.Sent, sent.Load(), expected, len(retries), newFailure.Load())
			if response.StatusCode != http.StatusOK {
				t.Fatalf("unexpected status=%d", response.StatusCode)
			}
			if scenario == "new_failure_during_send" {
				if !newFailure.Load() {
					t.Fatal("concurrency fixture did not execute")
				}
				if len(retries) != 1 || retries[0].Attempts != 2 || result.Recovered != 0 || sent.Load() != 1 {
					t.Fatal("newer failed work must survive completion of the older attempt")
				}
			} else if sent.Load() != expected || result.Sent != int(expected) || result.Recovered != 1 || len(retries) != 0 {
				t.Fatal("healthy retry must deliver all source rows and acknowledge only completed work")
			}
		})
	}
}
