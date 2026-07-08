package proxy

import (
	"context"
	"testing"
	"time"
)

func TestRedTeamThrottleQPS(t *testing.T) {
	// qps<=0 disables throttling: returns true immediately and stamps last.
	var last time.Time
	if !redTeamThrottleQPS(context.Background(), 0, &last) {
		t.Fatal("qps=0 must not block")
	}
	if last.IsZero() {
		t.Fatal("throttle must stamp last call time")
	}

	// A zero-value last means "first call" → no wait even with a rate limit.
	var first time.Time
	start := time.Now()
	if !redTeamThrottleQPS(context.Background(), 100, &first) {
		t.Fatal("first call must not block")
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Fatal("first call should not sleep")
	}

	// A cancelled context while a wait is pending returns false (caller aborts).
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recent := time.Now()
	if redTeamThrottleQPS(ctx, 0.5, &recent) { // 0.5 qps → 2s min interval, but ctx already done
		t.Fatal("cancelled context must abort the throttle wait")
	}
}

func TestRedTeamScheduleInterval(t *testing.T) {
	cases := map[string]time.Duration{
		"@hourly":   time.Hour,
		"@daily":    24 * time.Hour,
		"":          24 * time.Hour,
		"@weekly":   7 * 24 * time.Hour,
		"every:30m": 30 * time.Minute,
		"every:6h":  6 * time.Hour,
		"garbage":   24 * time.Hour,
	}
	for expr, want := range cases {
		if got := redTeamScheduleInterval(expr); got != want {
			t.Errorf("interval(%q) = %v, want %v", expr, got, want)
		}
	}
}

func TestRedTeamScheduleDue(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	// Never run → always due.
	if !redTeamScheduleDue("@daily", "", now) {
		t.Fatal("never-run schedule must be due")
	}
	// Ran 2h ago, hourly → due.
	if !redTeamScheduleDue("@hourly", now.Add(-2*time.Hour).Format(time.RFC3339Nano), now) {
		t.Fatal("hourly schedule 2h stale must be due")
	}
	// Ran 10m ago, hourly → not due.
	if redTeamScheduleDue("@hourly", now.Add(-10*time.Minute).Format(time.RFC3339Nano), now) {
		t.Fatal("hourly schedule 10m ago must NOT be due")
	}
	// Ran 25h ago, daily → due.
	if !redTeamScheduleDue("@daily", now.Add(-25*time.Hour).Format(time.RFC3339), now) {
		t.Fatal("daily schedule 25h stale must be due")
	}
}
