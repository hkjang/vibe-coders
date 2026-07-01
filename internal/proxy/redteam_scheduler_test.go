package proxy

import (
	"testing"
	"time"
)

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
