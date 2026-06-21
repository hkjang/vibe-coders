package store

import (
	"context"
	"testing"
	"time"
)

func TestCostAllocationWindowTeamAndBounds(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	if _, err := db.db.ExecContext(ctx,
		`INSERT INTO api_keys (id, name, key_hash, status, created_at, team) VALUES (?,?,?,?,?,?)`,
		"k1", "alpha key", "h1", "active", base.Format(time.RFC3339Nano), "alpha"); err != nil {
		t.Fatal(err)
	}
	mkReq := func(id string, when time.Time, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k1", Endpoint: "/v1/chat/completions",
				Model: "gpt-4", CostCenter: "CC-100", Project: "atlas", StatusCode: 200, CreatedAt: when},
			Usage: &TokenUsage{ID: "tu_" + id, RequestID: id, TotalTokens: 100, EstimatedCost: cost},
		}); err != nil {
			t.Fatal(err)
		}
	}
	mkReq("r_in1", base, 10)
	mkReq("r_in2", base.Add(time.Hour), 5)
	mkReq("r_before", base.AddDate(0, -1, 0), 99) // before window
	mkReq("r_after", base.AddDate(0, 1, 0), 77)    // after window

	monthStart := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	monthEnd := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)

	// Team dimension, bounded to June.
	team, err := db.CostAllocationWindow(ctx, "team", monthStart, monthEnd, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(team) != 1 || team[0].Key != "alpha" {
		t.Fatalf("expected one team 'alpha', got %+v", team)
	}
	if team[0].Requests != 2 || team[0].CostKRW != 15 {
		t.Fatalf("window bound failed (should exclude before/after): %+v", team[0])
	}

	// Cost-center dimension same window.
	cc, err := db.CostAllocationWindow(ctx, "cost_center", monthStart, monthEnd, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(cc) != 1 || cc[0].Key != "CC-100" || cc[0].Requests != 2 {
		t.Fatalf("cost_center allocation wrong: %+v", cc)
	}

	if _, err := db.CostAllocationWindow(ctx, "bogus", monthStart, monthEnd, 100); err == nil {
		t.Fatal("unsupported dimension should error")
	}
}
