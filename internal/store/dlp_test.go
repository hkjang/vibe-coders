package store

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// TestDLPSettingsRevisions checks that a DLP configuration is only ever saved on
// top of the revision the editor loaded, from the first save on.
func TestDLPSettingsRevisions(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()

	if _, found, err := db.GetDLPSettings(ctx); err != nil || found {
		t.Fatalf("before the first save: found=%v err=%v", found, err)
	}
	first, err := db.SaveDLPSettings(ctx, `{"enabled":true}`, 0, "alice")
	if err != nil || first.Revision != 1 {
		t.Fatalf("first save = %+v, %v", first, err)
	}
	// A second editor that also started before any save must not overwrite it.
	if _, err := db.SaveDLPSettings(ctx, `{"enabled":false}`, 0, "bob"); !errors.Is(err, ErrDLPSettingsConflict) {
		t.Fatalf("second first save err = %v, want conflict", err)
	}
	second, err := db.SaveDLPSettings(ctx, `{"enabled":true,"policies":[]}`, 1, "bob")
	if err != nil || second.Revision != 2 {
		t.Fatalf("save on revision 1 = %+v, %v", second, err)
	}
	if _, err := db.SaveDLPSettings(ctx, `{"enabled":false}`, 1, "carol"); !errors.Is(err, ErrDLPSettingsConflict) {
		t.Fatalf("stale save err = %v, want conflict", err)
	}
	stored, found, err := db.GetDLPSettings(ctx)
	if err != nil || !found {
		t.Fatalf("read back: found=%v err=%v", found, err)
	}
	if stored.Revision != 2 || stored.UpdatedBy != "bob" || stored.ConfigJSON != `{"enabled":true,"policies":[]}` {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestDLPEventsWriteFilterSummarizeAndPurge stores events with their request, then
// reads them back through every filter and summary dimension, and checks they are
// purged with the request for retention.
func TestDLPEventsWriteFilterSummarizeAndPurge(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Millisecond)
	old := now.AddDate(0, 0, -40)

	record := func(id string, at time.Time, events ...DLPEvent) LogRecord {
		return LogRecord{
			Request:   RequestLog{ID: id, TraceID: id, APIKeyID: "key_" + id, Endpoint: "/v1/chat/completions", Model: "gpt-4.1", StatusCode: 200, CreatedAt: at},
			DLPEvents: events,
		}
	}
	for _, rec := range []LogRecord{
		record("req_new", now,
			DLPEvent{ID: "dlp_a", TeamID: "support", Check: "REQUEST", Action: "FLAG", PolicyIDs: []string{"flag-pii"}, ProfileID: "pii",
				EntryIDs: []string{"email", "kr_mobile"}, MatchCount: 2, Confidence: "high",
				Evidence: []string{"이메일 주소: k•••@e•••.com (21자)"}, Hashes: []string{"0f3c2a9d1b7e4c55", "9a8b7c6d5e4f3a2b"}},
			DLPEvent{ID: "dlp_b", TeamID: "support", Check: "RESPONSE", Action: "MASK", PolicyIDs: []string{"mask-credentials"}, ProfileID: "credentials",
				EntryIDs: []string{"openai_api_key"}, MatchCount: 1, Confidence: "high", Hashes: []string{"1111222233334444"}},
		),
		record("req_block", now.Add(-time.Hour),
			DLPEvent{ID: "dlp_c", TeamID: "finance", Check: "REQUEST", Action: "BLOCK", PolicyIDs: []string{"block-government-ids"}, ProfileID: "government",
				EntryIDs: []string{"kr_rrn"}, MatchCount: 1, Confidence: "high"},
		),
		record("req_old", old,
			DLPEvent{ID: "dlp_old", TeamID: "support", Check: "REQUEST", Action: "FLAG", ProfileID: "pii", EntryIDs: []string{"email"}, MatchCount: 1},
		),
	} {
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatalf("insert %s: %v", rec.Request.ID, err)
		}
	}

	ids := func(events []DLPEvent) string {
		out := []string{}
		for _, e := range events {
			out = append(out, e.ID)
		}
		return strings.Join(out, ",")
	}
	all, err := db.ListDLPEvents(ctx, DLPEventFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(all); got != "dlp_b,dlp_a,dlp_c,dlp_old" {
		t.Fatalf("newest first = %s", got)
	}
	a := all[1]
	if a.RequestID != "req_new" || a.Endpoint != "/v1/chat/completions" || a.Model != "gpt-4.1" || !a.CreatedAt.Equal(now) {
		t.Fatalf("request fields not inherited: %+v", a)
	}
	if strings.Join(a.EntryIDs, ",") != "email,kr_mobile" || len(a.Hashes) != 2 || len(a.Evidence) != 1 || a.MatchCount != 2 {
		t.Fatalf("lists not round-tripped: %+v", a)
	}
	if b := all[0]; b.Evidence == nil || len(b.Evidence) != 0 {
		t.Fatalf("missing evidence must read back as an empty list, got %#v", b.Evidence)
	}

	for name, tc := range map[string]struct {
		filter DLPEventFilter
		want   string
	}{
		"since":   {DLPEventFilter{Since: now.Add(-2 * time.Hour)}, "dlp_b,dlp_a,dlp_c"},
		"team":    {DLPEventFilter{TeamID: "support"}, "dlp_b,dlp_a,dlp_old"},
		"action":  {DLPEventFilter{Action: "block"}, "dlp_c"},
		"check":   {DLPEventFilter{Check: "response"}, "dlp_b"},
		"profile": {DLPEventFilter{ProfileID: "pii"}, "dlp_a,dlp_old"},
		"request": {DLPEventFilter{RequestID: "req_new"}, "dlp_b,dlp_a"},
		"limit":   {DLPEventFilter{Limit: 1}, "dlp_b"},
	} {
		got, err := db.ListDLPEvents(ctx, tc.filter)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if ids(got) != tc.want {
			t.Fatalf("%s = %s, want %s", name, ids(got), tc.want)
		}
	}

	recent := DLPEventFilter{Since: now.Add(-2 * time.Hour)}
	summary := func(by string) map[string]DLPEventCount {
		rows, err := db.DLPEventSummary(ctx, recent, by)
		if err != nil {
			t.Fatalf("summary by %s: %v", by, err)
		}
		out := map[string]DLPEventCount{}
		for _, row := range rows {
			out[row.Key] = row
		}
		return out
	}
	if got := summary("action"); got["FLAG"].Matches != 2 || got["MASK"].Events != 1 || got["BLOCK"].Requests != 1 || len(got) != 3 {
		t.Fatalf("by action = %+v", got)
	}
	if got := summary("check_side"); got["REQUEST"].Events != 2 || got["REQUEST"].Requests != 2 || got["RESPONSE"].Events != 1 {
		t.Fatalf("by check = %+v", got)
	}
	if got := summary("team_id"); got["support"].Requests != 1 || got["support"].Events != 2 || got["finance"].Events != 1 {
		t.Fatalf("by team = %+v", got)
	}
	day := summary("day")
	total := int64(0)
	for key, row := range day {
		if _, err := time.Parse("2006-01-02", key); err != nil {
			t.Fatalf("day key %q is not a date", key)
		}
		total += row.Events
	}
	if total != 3 {
		t.Fatalf("by day = %+v", day)
	}
	if _, err := db.DLPEventSummary(ctx, recent, "evidence"); err == nil {
		t.Fatal("summary accepted an unsupported dimension")
	}

	if _, err := db.PurgeOlderThan(ctx, "request_logs", 30); err != nil {
		t.Fatal(err)
	}
	left, err := db.ListDLPEvents(ctx, DLPEventFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(left); got != "dlp_b,dlp_a,dlp_c" {
		t.Fatalf("after purge = %s, want the old request's event gone", got)
	}
}
