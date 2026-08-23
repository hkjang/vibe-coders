package store

import (
	"context"
	"testing"
	"time"
)

// Which day a request is charted on.
//
// Everything that costs money in this product runs on Seoul time — quota periods reset at
// KST midnight, budgets run on KST months, chargeback windows are KST, and the activity
// heatmap converts before bucketing. The daily and hourly charts did not: they cut the
// first characters off the stored UTC timestamp.
//
// The result was not an error, which is why it went unnoticed. It was the same traffic
// appearing as one day on one screen and two days on another, with every request between
// midnight and 09:00 KST charted against the previous day. An operator comparing a daily
// quota that had already reset against a chart that had not would find the two disagree,
// and neither would look broken.
func TestDailyBucketsFollowSeoulDaysNotUTC(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	kst := time.FixedZone("KST", 9*3600)

	// One Seoul day: an early start, a normal morning, and an evening session. The first
	// two are on the previous calendar day in UTC, which is the whole point.
	moments := []time.Time{
		time.Date(2026, 8, 24, 1, 30, 0, 0, kst),
		time.Date(2026, 8, 24, 8, 0, 0, 0, kst),
		time.Date(2026, 8, 24, 20, 0, 0, 0, kst),
	}
	for i, m := range moments {
		id := "tz-" + string(rune('a'+i))
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 10,
				CreatedAt: m.UTC(),
			},
			Usage: &TokenUsage{ID: "u-" + id, RequestID: id, TotalTokens: 100,
				EstimatedCost: 1000, Currency: "KRW", Source: "test"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Sanity: the fixture only means something if these really do straddle UTC midnight.
	if moments[0].UTC().Format("2006-01-02") == moments[2].UTC().Format("2006-01-02") {
		t.Fatal("the fixture no longer spans a UTC day boundary, so it proves nothing")
	}

	since := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	points, err := db.Timeseries(ctx, TimeseriesQuery{Bucket: "day", Since: since})
	if err != nil {
		t.Fatalf("timeseries: %v", err)
	}
	if len(points) != 1 {
		var got []string
		for _, p := range points {
			got = append(got, p.Date)
		}
		t.Fatalf("three requests sent on one Seoul day were charted across %d days (%v); "+
			"traffic before 09:00 KST is being attributed to the day before", len(points), got)
	}
	if points[0].Date != "2026-08-24" {
		t.Errorf("the day was labelled %q, want 2026-08-24 — the Seoul date the requests were sent on",
			points[0].Date)
	}
	if points[0].Requests != 3 || points[0].CostKRW != 3000 {
		t.Errorf("the day holds %d requests and %v KRW, want 3 and 3000; the totals do not "+
			"add up to what was sent that day", points[0].Requests, points[0].CostKRW)
	}

	// The heatmap already bucketed in Seoul time. The two must agree, because they are
	// answering the same question about the same rows.
	heat, err := db.HeatmapKST(ctx, since)
	if err != nil {
		t.Fatalf("heatmap: %v", err)
	}
	var heatTotal int64
	weekdays := map[int]bool{}
	for _, cell := range heat.Cells {
		heatTotal += cell.Requests
		weekdays[cell.Day] = true
	}
	if heatTotal != points[0].Requests {
		t.Errorf("the heatmap counts %d requests and the daily chart %d for the same rows",
			heatTotal, points[0].Requests)
	}
	if len(weekdays) != 1 {
		t.Errorf("the heatmap spread one Seoul day across %d weekdays", len(weekdays))
	}
}

// Hour buckets carry the same offset, and their labels are parsed downstream, so the
// shape has to survive the change as well as the value.
func TestHourBucketsAreSeoulHoursInTheExpectedShape(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	kst := time.FixedZone("KST", 9*3600)

	sent := time.Date(2026, 8, 24, 8, 30, 0, 0, kst) // 2026-08-23T23:30 UTC
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{
			ID: "hr-1", TraceID: "hr-1", Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 10, CreatedAt: sent.UTC(),
		},
	}); err != nil {
		t.Fatal(err)
	}

	points, err := db.Timeseries(ctx, TimeseriesQuery{
		Bucket: "hour", Since: time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("timeseries: %v", err)
	}
	if len(points) != 1 {
		t.Fatalf("expected a single hour bucket, got %d", len(points))
	}
	if points[0].Date != "2026-08-24T08" {
		t.Errorf("hour bucket is %q, want \"2026-08-24T08\" — 08:30 in Seoul, and in the "+
			"YYYY-MM-DDTHH shape callers parse", points[0].Date)
	}
}
