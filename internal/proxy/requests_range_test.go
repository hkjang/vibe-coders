package proxy

import (
	"testing"
	"time"
)

func TestSearchLocationDefaultsToSeoul(t *testing.T) {
	seoul := time.Date(2026, 7, 28, 0, 0, 0, 0, seoulZone)
	cases := map[string]*time.Location{
		"":           seoulZone,
		"Asia/Seoul": seoulZone,
		"kst":        seoulZone,
		"nonsense/x": seoulZone, // unknown → Seoul, never silently UTC
		"UTC":        time.UTC,
	}
	for tz, want := range cases {
		got := searchLocation(tz)
		// Compare by the offset they yield at a fixed instant (location pointers differ).
		_, wantOff := seoul.In(want).Zone()
		_, gotOff := seoul.In(got).Zone()
		if wantOff != gotOff {
			t.Errorf("searchLocation(%q) offset = %d, want %d", tz, gotOff, wantOff)
		}
	}
}

func TestParseRangeBound(t *testing.T) {
	// datetime-local input is interpreted in the supplied zone (KST here).
	got := parseRangeBound("2026-07-28T09:30", seoulZone, false)
	want := time.Date(2026, 7, 28, 9, 30, 0, 0, seoulZone)
	if !got.Equal(want) {
		t.Errorf("datetime-local KST = %v, want %v", got, want)
	}
	// The same wall clock in KST is 00:30 UTC — this is the off-by-9h the tz handling prevents.
	if h := got.UTC().Hour(); h != 0 {
		t.Errorf("KST 09:30 → UTC hour = %d, want 0", h)
	}

	// Date-only upper bound expands to the last instant of that KST day.
	to := parseRangeBound("2026-07-28", seoulZone, true)
	endWant := time.Date(2026, 7, 29, 0, 0, 0, 0, seoulZone).Add(-time.Nanosecond)
	if !to.Equal(endWant) {
		t.Errorf("date-only endOfDay = %v, want %v", to, endWant)
	}

	// Date-only lower bound is the start of that day.
	from := parseRangeBound("2026-07-28", seoulZone, false)
	if !from.Equal(time.Date(2026, 7, 28, 0, 0, 0, 0, seoulZone)) {
		t.Errorf("date-only start = %v", from)
	}

	// RFC3339 with explicit offset is absolute (zone arg ignored).
	abs := parseRangeBound("2026-07-28T00:00:00Z", seoulZone, false)
	if !abs.Equal(time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("RFC3339 absolute = %v", abs)
	}

	// Empty / unparseable → zero (bound disabled).
	if !parseRangeBound("", seoulZone, false).IsZero() {
		t.Error("empty should be zero")
	}
	if !parseRangeBound("not-a-date", seoulZone, false).IsZero() {
		t.Error("garbage should be zero")
	}
}
