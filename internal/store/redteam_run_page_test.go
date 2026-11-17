package store

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestRedTeamRunPageCompleteHistory(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 127; i++ {
		run := RedTeamRun{ID: fmt.Sprintf("run-%03d", i), CampaignID: "campaign", Status: "passed", Mode: "dry-run", CreatedAt: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano)}
		if i < 3 {
			run.SourceResultID, run.ReviewID, run.Mode, run.Status = "원본-결과", "review", "active-controlled", "stopped"
		}
		if err := db.InsertRedTeamRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	for offset := 0; offset < 127; offset += 25 {
		rows, total, err := db.RedTeamRunPage(t.Context(), RedTeamRunQuery{Limit: 25, Offset: offset})
		if err != nil || total != 127 || len(rows) == 0 || len(rows) > 25 {
			t.Fatal("page unavailable", total, err)
		}
		for _, run := range rows {
			if seen[run.ID] {
				t.Fatal("duplicate across pages")
			}
			seen[run.ID] = true
		}
	}
	if len(seen) != 127 {
		t.Fatal("old runs omitted")
	}
	q := RedTeamRunQuery{Limit: 25, SourceResultID: "원본-결과", ReviewID: "review", CampaignID: "campaign", Kind: "replay", Status: "stopped", Mode: "active-controlled", Sort: "created_at:asc"}
	rows, total, err := db.RedTeamRunPage(t.Context(), q)
	if err != nil || total != 3 || len(rows) != 3 || rows[0].ID != "run-000" {
		t.Fatal("old related receipts unavailable", err)
	}
	q.RunID = "run-001"
	rows, total, err = db.RedTeamRunPage(t.Context(), q)
	if err != nil || total != 1 || rows[0].ID != q.RunID {
		t.Fatal("exact run selection", err)
	}
	q.Kind = "campaign"
	rows, total, err = db.RedTeamRunPage(t.Context(), q)
	if err != nil || total != 0 || rows == nil || len(rows) != 0 {
		t.Fatal("conflicting filters broadened")
	}
	rows, total, err = db.RedTeamRunPage(t.Context(), RedTeamRunQuery{Limit: 25, Offset: 200})
	if err != nil || total != 127 || len(rows) != 0 {
		t.Fatal("out of range total lost")
	}
}

func TestRedTeamRunPageNanoWindowAndOrdering(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i, nano := range []int{0, 1, 10, 100000000, 100000001, 900000000} {
		run := RedTeamRun{ID: fmt.Sprintf("run-%d", i), CreatedAt: base.Add(time.Duration(nano)).Format(time.RFC3339Nano), Status: "passed", Mode: "dry-run", RiskScore: i % 2}
		if err := db.InsertRedTeamRun(t.Context(), run); err != nil {
			t.Fatal(err)
		}
	}
	q := RedTeamRunQuery{Limit: 25, From: base.Add(time.Nanosecond), To: base.Add(100000001 * time.Nanosecond)}
	rows, total, err := db.RedTeamRunPage(t.Context(), q)
	if err != nil || total != 3 || rows[0].ID != "run-3" || rows[2].ID != "run-1" {
		t.Fatal("precise half-open window failed", rows, err)
	}
	q = RedTeamRunQuery{Limit: 25, Sort: "risk_score:desc,created_at:asc"}
	rows, _, err = db.RedTeamRunPage(t.Context(), q)
	if err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"run-1", "run-3", "run-5", "run-0", "run-2", "run-4"} {
		if rows[i].ID != id {
			t.Fatal("multi-sort ignored", rows)
		}
	}
}

func TestRedTeamRunPageRejectsInvalidQuery(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	queries := []RedTeamRunQuery{
		{Limit: 0}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 1000001},
		{Limit: 25, Status: "unknown"}, {Limit: 25, Mode: "active"}, {Limit: 25, Kind: "all"},
		{Limit: 25, RunID: "x' OR 1=1"}, {Limit: 25, SourceResultID: "../secret"},
		{Limit: 25, From: time.Now()}, {Limit: 25, From: time.Now(), To: time.Unix(1, 0)},
	}
	for _, sort := range []string{"id", "id:DESC", "id:desc,id:asc", "id:desc,status:asc,risk_score:desc,cost_krw:asc", "created_at:desc;DROP TABLE redteam_runs", "prompt:asc"} {
		queries = append(queries, RedTeamRunQuery{Limit: 25, Sort: sort})
	}
	for _, q := range queries {
		if _, _, err := db.RedTeamRunPage(t.Context(), q); !errors.Is(err, ErrRedTeamRunPage) {
			t.Fatal("invalid query accepted", q, err)
		}
	}
}
