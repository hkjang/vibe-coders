package store

import (
	"context"
	"testing"
	"time"
)

func TestAICreditScores(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, apiKey string, status int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: apiKey, Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Provider: "openai", StatusCode: status, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 10, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// key_good: 6 requests all 200, cheap → high score.
	for i := 0; i < 6; i++ {
		rec("g"+itoaStore(i), "key_good", 200, 1)
	}
	// key_bad: 6 requests, half error, expensive → lower score.
	for i := 0; i < 6; i++ {
		status := 200
		if i%2 == 0 {
			status = 500
		}
		rec("b"+itoaStore(i), "key_bad", status, 100)
	}

	scores, err := db.AICreditScores(ctx, "api_key_id", now.Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]AICreditScore{}
	for _, s := range scores {
		byKey[s.Subject] = s
	}
	good, bad := byKey["key_good"], byKey["key_bad"]
	if good.Score <= bad.Score {
		t.Errorf("reliable+cheap key should outscore unreliable+expensive: good=%d bad=%d", good.Score, bad.Score)
	}
	if good.SuccessRate != 1 {
		t.Errorf("key_good success rate should be 1, got %f", good.SuccessRate)
	}
	if good.Confidence != "ok" {
		t.Errorf("6 requests should be ok confidence, got %q", good.Confidence)
	}
	// Sorted descending by score → key_good first.
	if len(scores) > 0 && scores[0].Subject != "key_good" {
		t.Errorf("highest score should sort first, got %q", scores[0].Subject)
	}
	// Unsupported dimension errors.
	if _, err := db.AICreditScores(ctx, "bogus", now.Add(-time.Hour), 100); err == nil {
		t.Error("unsupported dimension should error")
	}
}
