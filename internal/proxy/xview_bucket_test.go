package proxy

import (
	"testing"
	"time"
)

// XView buckets have to agree with the range that selected the rows.
//
// The from/to filter is parsed in Asia/Seoul unless the caller passes ?tz=, but the day
// bucket was labelled in UTC. A search for one Seoul day came back split across two, with
// the morning filed under the day before — and a bare "2026-08-23" carries no offset, so
// a client cannot correct it afterwards.
func TestXViewDayBucketsFollowTheFilterTimezone(t *testing.T) {
	kst := time.FixedZone("KST", 9*3600)
	seoul := searchLocation("") // the default a caller gets with no ?tz=
	moments := []time.Time{
		time.Date(2026, 8, 24, 1, 30, 0, 0, kst),
		time.Date(2026, 8, 24, 8, 0, 0, 0, kst),
		time.Date(2026, 8, 24, 20, 0, 0, 0, kst),
	}
	// The fixture is only meaningful if these straddle UTC midnight.
	if moments[0].UTC().Format("2006-01-02") == moments[2].UTC().Format("2006-01-02") {
		t.Fatal("the fixture no longer spans a UTC day boundary, so it proves nothing")
	}
	for _, m := range moments {
		got := bucketTimestamp(m.UTC().Format(time.RFC3339Nano), "day", seoul)
		if got != "2026-08-24" {
			t.Errorf("a request sent at %s Seoul was bucketed as %q, want 2026-08-24 — "+
				"the same day the from/to filter would have selected it by",
				m.Format("2006-01-02 15:04"), got)
		}
	}

	// A caller who asks for UTC gets UTC: the bucket follows the filter, it is not
	// hardcoded to Seoul either.
	utcDay := bucketTimestamp(moments[1].UTC().Format(time.RFC3339Nano), "day", searchLocation("UTC"))
	if utcDay != "2026-08-23" {
		t.Errorf("with ?tz=UTC the day bucket is %q, want 2026-08-23; the bucket should "+
			"follow the requested timezone rather than always using Seoul", utcDay)
	}
}

// The hour bucket is a UTC instant on purpose, and that is worth pinning so nobody
// "fixes" it later. Seoul is a whole-hour offset, so the boundaries coincide: the label
// already names the right moment in a form any client can convert, and rewriting it would
// change what an existing API consumer parses without making it more correct.
func TestXViewHourBucketStaysAConvertibleInstant(t *testing.T) {
	kst := time.FixedZone("KST", 9*3600)
	sent := time.Date(2026, 8, 24, 8, 0, 0, 0, kst)

	got := bucketTimestamp(sent.UTC().Format(time.RFC3339Nano), "hour", searchLocation(""))
	parsed, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Fatalf("hour bucket %q is not a parseable timestamp, so a client cannot convert it: %v", got, err)
	}
	if !parsed.Equal(sent.Truncate(time.Hour)) {
		t.Errorf("hour bucket %q is %v, want the hour containing %v", got, parsed, sent)
	}
	if parsed.In(kst).Hour() != 8 {
		t.Errorf("hour bucket %q reads as %02d:00 in Seoul, want 08:00", got, parsed.In(kst).Hour())
	}
}
