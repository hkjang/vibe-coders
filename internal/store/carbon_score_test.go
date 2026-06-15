package store

import (
	"context"
	"testing"
	"time"
)

func TestCarbonScores(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, model string, tokens int) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: model, Provider: "openai", StatusCode: 200, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: tokens, EstimatedCost: 1, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// big-model: 2 requests, 10K tokens each, expensive per-token energy.
	rec("a0", "big-model", 10000)
	rec("a1", "big-model", 10000)
	// small-model: 2 requests, 10K tokens each, cheap per-token energy.
	rec("b0", "small-model", 10000)
	rec("b1", "small-model", 10000)

	coeff := CarbonCoeff{
		DefaultWhPer1K:  0.4,
		PerModelWhPer1K: map[string]float64{"big-model": 1.0, "small-model": 0.1},
		PUE:             1.2,
		GridIntensityG:  475,
	}
	scores, err := db.CarbonScores(ctx, "model", now.Add(-time.Hour), 100, coeff)
	if err != nil {
		t.Fatal(err)
	}
	byModel := map[string]CarbonScore{}
	for _, s := range scores {
		byModel[s.Subject] = s
	}
	big, small := byModel["big-model"], byModel["small-model"]

	// big-model: 20000 tokens → 20 * 1.0 Wh * 1.2 PUE = 24 Wh.
	if got := big.EnergyWh; got < 23.99 || got > 24.01 {
		t.Errorf("big-model energy = %f Wh, want ~24", got)
	}
	// small-model: 20000 tokens → 20 * 0.1 * 1.2 = 2.4 Wh.
	if got := small.EnergyWh; got < 2.39 || got > 2.41 {
		t.Errorf("small-model energy = %f Wh, want ~2.4", got)
	}
	// CO2e = energy_kWh * grid intensity: 0.024 kWh * 475 = 11.4 g.
	if got := big.CO2eGrams; got < 11.39 || got > 11.41 {
		t.Errorf("big-model CO2e = %f g, want ~11.4", got)
	}
	// Higher-energy model sorts first.
	if len(scores) == 0 || scores[0].Subject != "big-model" {
		t.Errorf("highest emitter should sort first, got %+v", scores)
	}
	if big.Requests != 2 || big.TotalTokens != 20000 {
		t.Errorf("big-model aggregate = %d reqs / %d tokens, want 2 / 20000", big.Requests, big.TotalTokens)
	}

	// Unsupported dimension errors.
	if _, err := db.CarbonScores(ctx, "bogus", now.Add(-time.Hour), 100, coeff); err == nil {
		t.Error("unsupported dimension should error")
	}
}
