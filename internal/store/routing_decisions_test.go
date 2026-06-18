package store

import (
	"context"
	"testing"
	"time"
)

func insertHealthRequest(t *testing.T, db *SQLStore, id, provider string, status int, latency int64, failover bool, fallbackFrom, fallbackReason string, when time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: "key_health", Endpoint: "/v1/chat/completions",
			Model: "gpt-4.1", Provider: provider, StatusCode: status, LatencyMS: latency,
			Failover: failover, FallbackFrom: fallbackFrom, FallbackReason: fallbackReason, CreatedAt: when,
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProviderHealthScoresRankDegradedProviders(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	for i := 0; i < 10; i++ {
		insertHealthRequest(t, db, "fast-"+string(rune('a'+i)), "fast", 200, 100, false, "", "", now.Add(time.Duration(i)*time.Second))
		insertHealthRequest(t, db, "slow-"+string(rune('a'+i)), "slow", 200, 5000, false, "", "", now.Add(time.Duration(i)*time.Second))
	}
	insertHealthRequest(t, db, "bad-429", "degraded", 429, 900, false, "", "", now)
	insertHealthRequest(t, db, "bad-5xx", "degraded", 502, 900, false, "", "", now)
	insertHealthRequest(t, db, "bad-timeout", "degraded", 504, 900, false, "", "timeout", now)
	insertHealthRequest(t, db, "bad-fallback", "backup", 200, 100, true, "degraded", "timeout", now)

	scores, err := db.ProviderHealthScores(ctx, now.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	byProvider := map[string]ProviderHealthScore{}
	for _, s := range scores {
		byProvider[s.Provider] = s
		if s.Score < 0 || s.Score > 100 {
			t.Fatalf("health score out of range: %+v", s)
		}
	}
	if byProvider["fast"].Score <= byProvider["slow"].Score {
		t.Fatalf("fast provider should outrank slow: %+v", byProvider)
	}
	if byProvider["fast"].Score <= byProvider["degraded"].Score {
		t.Fatalf("fast provider should outrank degraded: %+v", byProvider)
	}
	degraded := byProvider["degraded"]
	if degraded.Rate429 != 1 || degraded.Rate5xx != 2 || degraded.Timeouts < 2 || degraded.Fallbacks != 1 {
		t.Fatalf("degraded provider signals not accumulated: %+v", degraded)
	}
	if degraded.FallbackRate <= 0 {
		t.Fatalf("expected fallback rate for degraded provider, got %+v", degraded)
	}
}

func TestProviderHealthScoresBetweenBoundsWindow(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	insertHealthRequest(t, db, "before", "old", 200, 100, false, "", "", now.Add(-2*time.Hour))
	insertHealthRequest(t, db, "inside-fast", "fast", 200, 100, false, "", "", now.Add(-30*time.Minute))
	insertHealthRequest(t, db, "inside-slow", "slow", 504, 2000, false, "", "timeout", now.Add(-20*time.Minute))
	insertHealthRequest(t, db, "after", "future", 200, 100, false, "", "", now.Add(time.Hour))

	scores, err := db.ProviderHealthScoresBetween(ctx, now.Add(-time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	byProvider := map[string]ProviderHealthScore{}
	for _, score := range scores {
		byProvider[score.Provider] = score
	}
	if _, ok := byProvider["old"]; ok {
		t.Fatalf("expected old provider outside lower bound, got %+v", byProvider)
	}
	if _, ok := byProvider["future"]; ok {
		t.Fatalf("expected future provider outside upper bound, got %+v", byProvider)
	}
	if byProvider["fast"].Requests != 1 || byProvider["slow"].Timeouts != 1 {
		t.Fatalf("bounded health signals not accumulated: %+v", byProvider)
	}
}
