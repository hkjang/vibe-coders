package store

import (
	"testing"
	"time"
)

func TestModelCatalogMonitorFiltersBeforeLimitsAndAcrossDelta(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := t.Context()
	now := time.Now().UTC()
	insert := func(id, endpoint, reason, model string, age time.Duration) {
		t.Helper()
		if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
			ID: id, TraceID: id, Endpoint: endpoint, RouteReason: reason, Model: model,
			StatusCode: 200, CreatedAt: now.Add(-age),
		}}); err != nil {
			t.Fatal(err)
		}
	}
	// Real inference may use an aggregate-like model name; never classify by name.
	insert("inference-old", "/v1/chat/completions", "rule", "models_aggregate", 3*time.Minute)
	insert("inference-new", "/v1/embeddings", "", "embed", 2*time.Minute)
	insert("catalog-path", "/v1/models", "pinned", "", time.Minute)
	insert("catalog-reason", "", "models_aggregate", "", 30*time.Second)
	insert("catalog-legacy", "", "model_aggregate", "", 20*time.Second)
	filter := AppRequestFilter{Limit: 1, ExcludeModels: true}
	first, more, err := db.AppRecentRequests(ctx, filter)
	if err != nil || !more || len(first) != 1 || first[0].RequestID != "inference-new" {
		t.Fatalf("filtered first page=%+v more=%v err=%v", first, more, err)
	}
	filter.CursorAt, filter.CursorID, filter.Direction = first[0].CreatedAt, first[0].RequestID, "next"
	second, more, err := db.AppRecentRequests(ctx, filter)
	if err != nil || more || len(second) != 1 || second[0].RequestID != "inference-old" {
		t.Fatalf("filtered second page=%+v more=%v err=%v", second, more, err)
	}
	all, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 10})
	if err != nil || len(all) != 5 {
		t.Fatalf("audit rows changed: len=%d err=%v", len(all), err)
	}
	scatter := ScatterFilter{Since: now.Add(-time.Hour), ExcludeModels: true, Limit: 2}
	points, truncated, err := db.ScatterPoints(ctx, scatter)
	if err != nil || truncated || len(points) != 2 {
		t.Fatalf("snapshot=%+v truncated=%v err=%v", points, truncated, err)
	}
	cursor, err := db.LatestScatterCursor(ctx, scatter)
	if err != nil {
		t.Fatal(err)
	}
	// Catalog-only arrivals still advance the transport cursor, preventing repeated scans.
	insert("later-catalog", "/v1/models", "models_aggregate", "", 0)
	after, err := time.Parse(time.RFC3339Nano, cursor.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	points, next, more, err := db.ScatterDelta(ctx, scatter, after, cursor.RequestID, false, false)
	if err != nil || len(points) != 0 || more || next.RequestID != "later-catalog" {
		t.Fatalf("metadata delta=%+v cursor=%+v more=%v err=%v", points, next, more, err)
	}
	insert("later-inference", "/v1/chat/completions", "rule", "chat", 0)
	after, _ = time.Parse(time.RFC3339Nano, next.IngestedAt)
	points, _, _, err = db.ScatterDelta(ctx, scatter, after, next.RequestID, true, true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, point := range points {
		if point.Endpoint == "/v1/models" || point.RequestID == "catalog-reason" || point.RequestID == "catalog-legacy" {
			t.Fatalf("catalog leaked into refreshed delta: %+v", point)
		}
		found = found || point.RequestID == "later-inference"
	}
	if !found {
		t.Fatal("real inference lost after catalog-only cursor advancement")
	}
}
