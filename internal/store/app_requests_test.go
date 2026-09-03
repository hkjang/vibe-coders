package store

import (
	"context"
	"testing"
	"time"
)

func TestAppRecentRequestsKeysetAndFilters(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	tiedAt := time.Date(2026, 9, 3, 1, 2, 3, 4, time.UTC)
	for _, item := range []struct {
		id, provider string
		status       int
	}{
		{id: "req-a", provider: "provider-a", status: 200},
		{id: "req-c", provider: "provider-a", status: 200},
		{id: "req-b", provider: "provider-b", status: 500},
	} {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: item.id, TraceID: "trace-" + item.id, APIKeyID: "key-a",
				ClientIP: "192.0.2.10", Model: "model-a", Provider: item.provider,
				Endpoint: "/v1/chat/completions", StatusCode: item.status, CreatedAt: tiedAt},
			Languages: []LanguageStat{{ID: "lang-" + item.id, RequestID: item.id, Language: "ko", Confidence: .9, CreatedAt: tiedAt}},
		}); err != nil {
			t.Fatal(err)
		}
	}

	first, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, Language: "ko", StatusMin: 200, StatusMax: 599})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(first) != 1 || first[0].RequestID != "req-c" {
		t.Fatalf("first page = %+v more=%v", first, more)
	}
	second, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, CursorAt: first[0].CreatedAt, CursorID: first[0].RequestID, Direction: "older"})
	if err != nil {
		t.Fatal(err)
	}
	if !more || len(second) != 1 || second[0].RequestID != "req-b" {
		t.Fatalf("second page = %+v more=%v", second, more)
	}
	previous, more, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 1, CursorAt: second[0].CreatedAt, CursorID: second[0].RequestID, Direction: "newer"})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(previous) != 1 || previous[0].RequestID != "req-c" {
		t.Fatalf("previous page = %+v more=%v", previous, more)
	}
	filtered, _, err := db.AppRecentRequests(ctx, AppRequestFilter{Limit: 20, Provider: "provider-b", ProviderSet: true, StatusCode: 500, IP: "192.0.2.10"})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].RequestID != "req-b" {
		t.Fatalf("filtered page = %+v", filtered)
	}
}
