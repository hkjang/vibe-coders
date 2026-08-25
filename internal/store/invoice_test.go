package store

import (
	"context"
	"testing"
	"time"
)

func TestCostCenterInvoiceData(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, costCenter, model string, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: model, CostCenter: costCenter, StatusCode: 200, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Cost center "CC-1": gpt-4.1 (2 reqs @ 10) + gpt-4.1-mini (3 reqs @ 1).
	rec("a0", "CC-1", "gpt-4.1", 10)
	rec("a1", "CC-1", "gpt-4.1", 10)
	rec("b0", "CC-1", "gpt-4.1-mini", 1)
	rec("b1", "CC-1", "gpt-4.1-mini", 1)
	rec("b2", "CC-1", "gpt-4.1-mini", 1)
	// A different cost center, must not bleed in.
	rec("x0", "CC-2", "gpt-4.1", 10)

	inv, err := db.CostCenterInvoiceData(ctx, "CC-1", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if inv.CostCenter != "CC-1" {
		t.Errorf("cost center = %q, want CC-1", inv.CostCenter)
	}
	if inv.TotalRequests != 5 || inv.TotalTokens != 500 {
		t.Errorf("totals = %d reqs / %d tokens, want 5 / 500", inv.TotalRequests, inv.TotalTokens)
	}
	if inv.TotalCostKRW < 22.99 || inv.TotalCostKRW > 23.01 {
		t.Errorf("total cost = %f, want ~23", inv.TotalCostKRW)
	}
	if len(inv.LineItems) != 2 {
		t.Fatalf("expected 2 line items, got %d", len(inv.LineItems))
	}
	// Most expensive model (gpt-4.1, cost 20) sorts first.
	if inv.LineItems[0].Model != "gpt-4.1" || inv.LineItems[0].CostKRW < 19.99 {
		t.Errorf("first line item = %+v, want gpt-4.1 @ ~20", inv.LineItems[0])
	}

	// Unset cost center matches via '(unset)'.
	rec("u0", "", "gpt-4.1", 5)
	unset, err := db.CostCenterInvoiceData(ctx, "(unset)", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if unset.TotalRequests != 1 {
		t.Errorf("(unset) invoice requests = %d, want 1", unset.TotalRequests)
	}
}
