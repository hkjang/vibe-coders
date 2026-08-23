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

// The rollup has to agree with the live chart, because it replaces it.
//
// analytics_daily rows outlive the raw logs they were built from: retention rolls up the
// last few days and then deletes the detail. Once that has happened the rollup is the only
// source a chart has for that day. If it bucketed by UTC while the live path buckets by
// Seoul, a trend line would change its definition of a day partway along, at the retention
// boundary, with nothing on the chart to mark it. That is worse than being uniformly
// wrong: uniformly wrong is at least comparable with itself.
func TestRollupAgreesWithTheLiveChartOnWhichDayIsWhich(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	kst := time.FixedZone("KST", 9*3600)

	// The same Seoul day that straddles UTC midnight.
	moments := []time.Time{
		time.Date(2026, 8, 24, 1, 30, 0, 0, kst),
		time.Date(2026, 8, 24, 8, 0, 0, 0, kst),
		time.Date(2026, 8, 24, 20, 0, 0, 0, kst),
	}
	for i, m := range moments {
		id := "rl-" + string(rune('a'+i))
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 10, CreatedAt: m.UTC(),
			},
			Usage: &TokenUsage{ID: "u-" + id, RequestID: id, TotalTokens: 100,
				EstimatedCost: 1000, Currency: "KRW", Source: "test"},
		}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := db.RollupRange(ctx,
		time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("rollup: %v", err)
	}

	rows, err := db.ListDailyRollups(ctx, "all", "2026-08-01", 100)
	if err != nil {
		t.Fatalf("list rollups: %v", err)
	}
	byDay := map[string]AnalyticsRollupRow{}
	for _, r := range rows {
		if r.Requests > 0 {
			byDay[r.Day] = r
		}
	}
	if len(byDay) != 1 {
		t.Fatalf("one Seoul day of traffic produced %d rollup days (%v); the rollup and the "+
			"live chart disagree about which day these requests belong to", len(byDay), byDay)
	}
	row, ok := byDay["2026-08-24"]
	if !ok {
		t.Fatalf("the rollup filed the traffic under %v, not 2026-08-24", byDay)
	}
	if row.Requests != 3 || row.CostKRW != 3000 {
		t.Errorf("rollup for 2026-08-24 has %d requests / %v KRW, want 3 / 3000",
			row.Requests, row.CostKRW)
	}

	// And the same numbers as the live path, which is the assertion that actually
	// protects the trend line across the retention boundary.
	points, err := db.Timeseries(ctx, TimeseriesQuery{
		Bucket: "day", Since: time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("timeseries: %v", err)
	}
	if len(points) != 1 || points[0].Date != row.Day ||
		points[0].Requests != row.Requests || points[0].CostKRW != row.CostKRW {
		t.Errorf("live chart says %+v, rollup says %+v; a chart reading one before retention "+
			"and the other after would step", points, row)
	}
}

// RollupRange converts its endpoints to Seoul. A request just before UTC midnight belongs
// to the next Seoul day, so this checks that day is still covered rather than falling off
// the end of the loop — the failure would be a permanently missing aggregate, visible only
// after retention had removed the rows it could have been rebuilt from.
func TestRollupRangeCoversTheSeoulDayAtTheBoundary(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	// 2026-08-24 23:00 UTC is 2026-08-25 08:00 in Seoul.
	sent := time.Date(2026, 8, 24, 23, 0, 0, 0, time.UTC)
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{
			ID: "edge-1", TraceID: "edge-1", Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 10, CreatedAt: sent,
		},
		Usage: &TokenUsage{ID: "u-edge-1", RequestID: "edge-1", TotalTokens: 10,
			EstimatedCost: 100, Currency: "KRW", Source: "test"},
	}); err != nil {
		t.Fatal(err)
	}

	// A UTC range that ends on the 24th; the request's Seoul day is the 25th.
	if _, err := db.RollupRange(ctx,
		time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 24, 23, 59, 0, 0, time.UTC)); err != nil {
		t.Fatalf("rollup: %v", err)
	}

	rows, err := db.ListDailyRollups(ctx, "all", "2026-08-01", 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.Day == "2026-08-25" && r.Requests == 1 {
			return
		}
	}
	t.Errorf("the request at 23:00 UTC belongs to Seoul day 2026-08-25, which the rollup "+
		"did not cover: %+v\nOnce retention removes the raw row that day's aggregate is gone.", rows)
}
