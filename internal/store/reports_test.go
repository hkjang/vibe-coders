package store

import (
	"context"
	"testing"
	"time"
)

func TestUserCodingReportSince(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, session, model string, status int, when time.Time, tokens int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_alice", SessionID: session,
				Endpoint: "/v1/chat/completions", Model: model, Provider: "openai",
				StatusCode: status, LatencyMS: 120, CreatedAt: when,
			},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Session A: two requests 5 minutes apart (one error).
	rec("a1", "sess_a", "gpt-4.1-mini", 200, now.Add(-2*time.Hour), 100, 10)
	rec("a2", "sess_a", "gpt-4.1-mini", 500, now.Add(-2*time.Hour).Add(5*time.Minute), 50, 5)
	// Session B: single request.
	rec("b1", "sess_b", "gpt-4.1", 200, now.Add(-1*time.Hour), 200, 40)
	// Old request outside the 7d window — must be excluded.
	rec("old", "sess_old", "gpt-4.1", 200, now.Add(-30*24*time.Hour), 999, 999)

	report, err := db.UserCodingReportSince(ctx, "key_alice", now.Add(-7*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	if report.Requests != 3 {
		t.Errorf("requests = %d, want 3 (old excluded)", report.Requests)
	}
	if report.Tokens != 350 {
		t.Errorf("tokens = %d, want 350", report.Tokens)
	}
	if report.Errors != 1 {
		t.Errorf("errors = %d, want 1", report.Errors)
	}
	if report.ErrorRate < 0.33 || report.ErrorRate > 0.34 {
		t.Errorf("error_rate = %f, want ~0.333", report.ErrorRate)
	}
	if len(report.TopModels) == 0 || report.TopModels[0].Key != "gpt-4.1-mini" {
		t.Errorf("expected gpt-4.1-mini as top model, got %+v", report.TopModels)
	}
	if report.Sessions != 2 {
		t.Errorf("sessions = %d, want 2", report.Sessions)
	}
	// Session A spans 5 minutes (300s); B spans 0. Total work ~300s.
	if report.WorkSeconds < 290 || report.WorkSeconds > 310 {
		t.Errorf("work_seconds = %f, want ~300", report.WorkSeconds)
	}
}

func TestCostAllocationByProject(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project, costCenter string, status int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_x", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Provider: "openai", StatusCode: status,
				Project: project, CostCenter: costCenter, CreatedAt: now,
			},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 10, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	rec("p1", "alpha", "CC-100", 200, 100)
	rec("p2", "alpha", "CC-100", 500, 200)
	rec("p3", "beta", "CC-200", 200, 50)
	rec("p4", "", "", 200, 5) // unset bucket

	rows, err := db.CostAllocation(ctx, "project", now.Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]CostAllocationRow{}
	for _, r := range rows {
		byKey[r.Key] = r
	}
	if byKey["alpha"].CostKRW != 300 {
		t.Errorf("alpha cost = %f, want 300", byKey["alpha"].CostKRW)
	}
	if byKey["alpha"].Errors != 1 {
		t.Errorf("alpha errors = %d, want 1", byKey["alpha"].Errors)
	}
	if byKey["beta"].Requests != 1 {
		t.Errorf("beta requests = %d, want 1", byKey["beta"].Requests)
	}
	if _, ok := byKey["(unset)"]; !ok {
		t.Error("expected an (unset) bucket for the empty project")
	}

	// cost_center dimension works too.
	ccRows, err := db.CostAllocation(ctx, "cost_center", now.Add(-time.Hour), 100)
	if err != nil || len(ccRows) == 0 {
		t.Fatalf("cost_center allocation failed: %v rows=%d", err, len(ccRows))
	}

	if _, err := db.CostAllocation(ctx, "bogus", now.Add(-time.Hour), 100); err == nil {
		t.Error("expected error for unsupported dimension")
	}
}

func TestUserCodingReportNotFound(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	_, err := db.UserCodingReportSince(context.Background(), "key_ghost", time.Now().Add(-7*24*time.Hour))
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound for an unknown key, got %v", err)
	}
}
