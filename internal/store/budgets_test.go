package store

import (
	"context"
	"math"
	"testing"
	"time"
)

// insertCost logs one request with an explicit estimated_cost (KRW) at time `when`.
func insertCost(t *testing.T, db *SQLStore, id, apiKeyID string, cost float64, when time.Time) {
	t.Helper()
	rec := LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, Endpoint: "/v1/chat/completions",
			Model: "gpt-4.1", StatusCode: 200, CreatedAt: when,
		},
		Usage: &TokenUsage{
			ID: id + "-u", RequestID: id, PromptTokens: 50, CompletionTokens: 50, TotalTokens: 100,
			EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when,
		},
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

// midMonthNow returns noon KST on the 15th of the current month — a deterministic
// "now" that always leaves enough of the month elapsed/remaining for forecasting.
func midMonthNow() time.Time {
	n := time.Now().In(budgetKST)
	return time.Date(n.Year(), n.Month(), 15, 12, 0, 0, 0, budgetKST)
}

func TestBudgetStatusForecastOverTrend(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	now := midMonthNow()
	start, daysInMonth := kstMonthBounds(now)
	spendAt := start.Add(time.Hour)

	if err := db.UpsertBudget(ctx, Budget{ID: "b-over", Scope: "global", ScopeValue: "*", MonthlyKRW: 10000}); err != nil {
		t.Fatal(err)
	}
	// Spend 8,000 of a 10,000 budget by mid-month -> run-rate clearly exceeds budget.
	insertCost(t, db, "r1", "anonymous", 8000, spendAt)

	statuses, err := db.BudgetStatuses(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 {
		t.Fatalf("want 1 status, got %d", len(statuses))
	}
	st := statuses[0]
	if math.Abs(st.SpentKRW-8000) > 1e-6 {
		t.Fatalf("spent: want 8000 got %v", st.SpentKRW)
	}
	if math.Abs(st.BurnRatio-0.8) > 1e-6 {
		t.Fatalf("burn ratio: want 0.8 got %v", st.BurnRatio)
	}
	elapsed := now.Sub(start).Hours() / 24
	wantProj := (8000 / elapsed) * daysInMonth
	if math.Abs(st.ProjectedKRW-wantProj) > 1.0 {
		t.Fatalf("projected: want ~%v got %v", wantProj, st.ProjectedKRW)
	}
	if st.OnTrack {
		t.Fatalf("expected not on track (projected %v > budget 10000)", st.ProjectedKRW)
	}
	if st.ExhaustionDate == "" {
		t.Fatalf("expected an exhaustion date when over-trending")
	}
}

func TestBudgetStatusOnTrack(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	now := midMonthNow()
	start, _ := kstMonthBounds(now)
	spendAt := start.Add(time.Hour)

	if err := db.UpsertBudget(ctx, Budget{ID: "b-ok", Scope: "global", ScopeValue: "*", MonthlyKRW: 1000000}); err != nil {
		t.Fatal(err)
	}
	insertCost(t, db, "r1", "anonymous", 8000, spendAt)

	statuses, err := db.BudgetStatuses(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	st := statuses[0]
	if !st.OnTrack {
		t.Fatalf("expected on track (projected %v <= budget 1000000)", st.ProjectedKRW)
	}
	if st.ExhaustionDate != "" {
		t.Fatalf("did not expect exhaustion date, got %q", st.ExhaustionDate)
	}
}

func TestMaxBudgetProjectedRatio(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	now := midMonthNow()
	start, daysInMonth := kstMonthBounds(now)
	spendAt := start.Add(time.Hour)

	// Two global budgets see the same spend; the tighter one has the higher ratio.
	if err := db.UpsertBudget(ctx, Budget{ID: "b-tight", Scope: "global", ScopeValue: "*", MonthlyKRW: 10000}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertBudget(ctx, Budget{ID: "b-loose", Scope: "global", ScopeValue: "*", MonthlyKRW: 1000000}); err != nil {
		t.Fatal(err)
	}
	insertCost(t, db, "r1", "anonymous", 8000, spendAt)

	got, err := db.MaxBudgetProjectedRatio(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := now.Sub(start).Hours() / 24
	wantMax := ((8000 / elapsed) * daysInMonth) / 10000
	if math.Abs(got-wantMax) > 1e-3 {
		t.Fatalf("max projected ratio: want ~%v got %v", wantMax, got)
	}
}

func TestBudgetCRUDRoundTrip(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertBudget(ctx, Budget{ID: "b1", Scope: "team", ScopeValue: "platform", MonthlyKRW: 50000, Note: "플랫폼팀"}); err != nil {
		t.Fatal(err)
	}
	list, err := db.ListBudgets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ScopeValue != "platform" || list[0].MonthlyKRW != 50000 {
		t.Fatalf("unexpected list after insert: %+v", list)
	}
	// upsert same id updates in place
	if err := db.UpsertBudget(ctx, Budget{ID: "b1", Scope: "team", ScopeValue: "platform", MonthlyKRW: 80000}); err != nil {
		t.Fatal(err)
	}
	list, _ = db.ListBudgets(ctx)
	if len(list) != 1 || list[0].MonthlyKRW != 80000 {
		t.Fatalf("expected updated budget, got %+v", list)
	}
	if err := db.DeleteBudget(ctx, "b1"); err != nil {
		t.Fatal(err)
	}
	list, _ = db.ListBudgets(ctx)
	if len(list) != 0 {
		t.Fatalf("expected empty after delete, got %+v", list)
	}
}
