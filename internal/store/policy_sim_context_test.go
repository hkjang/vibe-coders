package store

import (
	"context"
	"testing"
	"time"
)

func TestGovernanceSimContextsCarryStatusAndCost(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Now().UTC().Add(-10 * time.Minute)

	rec := LogRecord{
		Request: RequestLog{ID: "ps1", Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai", StatusCode: 200, CreatedAt: when},
		Usage:   &TokenUsage{ID: "ps1_u", RequestID: "ps1", TotalTokens: 50, EstimatedCost: 12.5, Currency: "KRW", CreatedAt: when},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}

	ctxs, err := db.GovernanceSimContexts(ctx, when.Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	var got *GovernanceSimContext
	for i := range ctxs {
		if ctxs[i].Model == "gpt-4.1" {
			got = &ctxs[i]
		}
	}
	if got == nil {
		t.Fatal("expected the seeded request in sim contexts")
	}
	if got.StatusCode != 200 {
		t.Fatalf("status_code = %d, want 200", got.StatusCode)
	}
	if got.CostKRW != 12.5 {
		t.Fatalf("cost_krw = %v, want 12.5", got.CostKRW)
	}
}
