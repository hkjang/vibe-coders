package store

import (
	"context"
	"testing"
	"time"
)

func TestSessionLoopAnomalies(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, session, fp string, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_loop", SessionID: session,
				Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai", StatusCode: 200,
				PromptFingerprint: fp, CreatedAt: now,
			},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Looping session: 6 identical-fingerprint requests.
	for i := 0; i < 6; i++ {
		rec("loop"+string(rune('a'+i)), "sess_loop", "fp_same", 10)
	}
	// Healthy session: 3 distinct fingerprints.
	rec("h1", "sess_ok", "fp_a", 5)
	rec("h2", "sess_ok", "fp_b", 5)
	rec("h3", "sess_ok", "fp_c", 5)

	loops, err := db.SessionLoopAnomalies(ctx, now.Add(-time.Hour), 5, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(loops) != 1 {
		t.Fatalf("expected 1 loop anomaly, got %d: %+v", len(loops), loops)
	}
	if loops[0].SessionID != "sess_loop" || loops[0].Repeats != 6 {
		t.Errorf("unexpected loop: %+v", loops[0])
	}
	if loops[0].CostKRW != 60 {
		t.Errorf("loop cost = %f, want 60", loops[0].CostKRW)
	}
}
