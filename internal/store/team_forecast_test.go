package store

import (
	"context"
	"testing"
	"time"
)

func TestTeamMonthlyForecast(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	monthStart, _ := kstMonthBounds(now)

	// Register a team key + a team budget for "platform".
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_p", Name: "p", KeyHash: "h1", Team: "platform", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertBudget(ctx, Budget{ID: "b1", Scope: "team", ScopeValue: "platform", MonthlyKRW: 1000}); err != nil {
		t.Fatal(err)
	}

	// Spend > budget already this month so the month-end projection (>= spend)
	// always exceeds, independent of the day the test runs.
	spendAt := monthStart.Add(12 * time.Hour)
	for i := 0; i < 5; i++ {
		id := "r" + string(rune('a'+i))
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "key_p", Endpoint: "/v1/chat/completions", Model: "m", Provider: "p", StatusCode: 200, CreatedAt: spendAt},
			Usage:   &TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 10, EstimatedCost: 250, Currency: "KRW", CreatedAt: spendAt},
		}); err != nil {
			t.Fatal(err)
		}
	}

	forecasts, err := db.TeamMonthlyForecast(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	var platform *TeamForecast
	for i := range forecasts {
		if forecasts[i].Team == "platform" {
			platform = &forecasts[i]
		}
	}
	if platform == nil {
		t.Fatal("platform team forecast missing")
	}
	if platform.SpentKRW != 1250 {
		t.Errorf("spent = %g, want 1250", platform.SpentKRW)
	}
	if !platform.HasBudget || platform.BudgetKRW != 1000 {
		t.Errorf("expected platform to have a 1000 budget, got %+v", platform)
	}
	if !platform.WillExceed || platform.ProjectedKRW < platform.SpentKRW {
		t.Errorf("expected projected overage, got projected=%g exceed=%v", platform.ProjectedKRW, platform.WillExceed)
	}
	if platform.OverageKRW <= 0 {
		t.Errorf("expected positive overage, got %g", platform.OverageKRW)
	}
}
