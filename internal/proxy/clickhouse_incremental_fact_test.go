package proxy

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestClickHouseIncrementalFactsDoNotRepeatConfirmedBoundary(t *testing.T) {
	for _, scenario := range []struct {
		dimension string
		legacy    bool
	}{{"text2sql_fact", false}, {"redteam_fact", false}, {"text2sql_fact", true}, {"redteam_fact", true}} {
		t.Run(fmt.Sprintf("%s/legacy=%t", scenario.dimension, scenario.legacy), func(t *testing.T) {
			dimension := scenario.dimension
			db := openTestStore(t)
			at := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
			if dimension == "redteam_fact" {
				if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "fixture", Enabled: true}}); err != nil {
					t.Fatal(err)
				}
				if err := db.UpsertRedTeamCampaign(t.Context(), store.RedTeamCampaign{ID: "campaign", Name: "fixture"}); err != nil {
					t.Fatal(err)
				}
				if err := db.InsertRedTeamRun(t.Context(), store.RedTeamRun{ID: "run", CampaignID: "campaign", TargetID: "target"}); err != nil {
					t.Fatal(err)
				}
			}
			seed := func(id string, stamp time.Time) {
				t.Helper()
				var err error
				if dimension == "text2sql_fact" {
					err = db.InsertText2SQLLog(t.Context(), store.Text2SQLQueryLog{ID: id, Mode: "execute", CreatedAt: stamp})
				} else {
					err = db.InsertRedTeamCaseResult(t.Context(), store.RedTeamCaseResult{ID: id, RunID: "run", Decision: "pass", Severity: "info", CreatedAt: stamp.Format(time.RFC3339Nano)})
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			seed("fact-001", at)
			seed("fact-002", at)
			var calls, accepted atomic.Int64
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					w.WriteHeader(500)
					return
				}
				body := strings.TrimSpace(string(raw))
				if body != "" {
					accepted.Add(int64(len(strings.Split(body, "\n"))))
				}
				w.WriteHeader(200)
			}))
			defer sink.Close()
			cfg := testConfig("http://fixture.invalid", "fixture")
			cfg.ClickHouse.URL = sink.URL
			cfg.ClickHouse.Text2SQLFactTable = "text2sql_fact"
			cfg.ClickHouse.RedTeamFactTable = "redteam_fact"
			sync := func(want int) {
				t.Helper()
				server, err := NewServer(cfg, db, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				n, err := server.syncClickHouseFactDimension(t.Context(), dimension)
				if err != nil || n != want {
					t.Fatalf("incremental expected=%d reported=%d actual_total=%d calls=%d err=%v", want, n, accepted.Load(), calls.Load(), err)
				}
			}
			if scenario.legacy {
				// Simulate a pre-upgrade watermark that recorded timestamp only.
				if _, err := db.CompleteClickHouseSink(t.Context(), dimension, at.Format(time.RFC3339Nano), 2, nil); err != nil {
					t.Fatal(err)
				}
				sync(0)
				seed("fact-003", at.Add(time.Second))
				sync(1)
				sync(0)
				seed("fact-004", at.Add(time.Second))
				sync(1)
				sync(0)
				if calls.Load() != 2 || accepted.Load() != 2 {
					t.Fatal("legacy boundary duplicated or failed to transition to identity cursor")
				}
				return
			}
			sync(2)
			before, err := db.ListClickHouseSinkState(t.Context())
			if err != nil || len(before) != 1 {
				t.Fatal("missing confirmed watermark")
			}
			sync(0) // A new Server on the same DB must not send the last timestamp again.
			after, err := db.ListClickHouseSinkState(t.Context())
			if err != nil || len(after) != 1 || after[0] != before[0] {
				t.Fatal("empty incremental cycle changed confirmed watermark")
			}
			seed("fact-003", at)
			sync(1)
			sync(0)
			seed("fact-004", at.Add(time.Second))
			sync(1)
			sync(0)
			if calls.Load() != 3 || accepted.Load() != 4 {
				t.Fatal("confirmed facts duplicated")
			}
			// An explicit pending retry still includes the boundary and its earlier rows.
			if err := db.RecordClickHouseSinkFailure(t.Context(), dimension, at.Format(time.RFC3339Nano), "explicit retry fixture"); err != nil {
				t.Fatal(err)
			}
			sync(4)
			sync(0)
			if accepted.Load() != 8 || calls.Load() != 4 {
				t.Fatal("explicit retry lost its inclusive source interval")
			}
		})
	}
}
