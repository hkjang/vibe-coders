package store

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"
)

// logUsage writes one request with its token usage, the way the async logger does.
func logUsage(t *testing.T, db *SQLStore, id, apiKeyID, clientIP string, tokens int, cost float64, when time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, ClientIP: clientIP,
			Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai",
			StatusCode: 200, LatencyMS: 100, CreatedAt: when,
		},
		Usage: &TokenUsage{ID: "u" + id, RequestID: id, TotalTokens: tokens, EstimatedCost: cost, CreatedAt: when},
	}); err != nil {
		t.Fatalf("insert %s: %v", id, err)
	}
}

// The whole point of the day totals is that they answer the same question as the aggregate
// they replace. Anything else is a quota enforced against a number nobody can reconcile
// with the usage screen, so this is the test the rest of the design has to satisfy.
func TestUsageForPeriodAgreesWithTheExactAggregate(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	// Two teams, one key with no team, and traffic that never minted a key.
	for _, k := range []struct{ id, team string }{
		{"k-alpha", "alpha"}, {"k-alpha-2", "alpha"}, {"k-beta", "beta"}, {"k-loose", ""},
	} {
		if err := db.UpsertAPIKey(ctx, APIKeyRecord{
			ID: k.id, Name: k.id, KeyHash: "h-" + k.id, Owner: "o", Team: k.team,
			Status: "active", CreatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)
	keys := []string{"k-alpha", "k-alpha-2", "k-beta", "k-loose", "", "k-vanished"}
	ips := []string{"10.0.0.1", "10.0.0.2", ""}

	n := 0
	for dayOffset := 0; dayOffset < 4; dayOffset++ {
		day := today.AddDate(0, 0, -dayOffset)
		for i := 0; i < 9; i++ {
			n++
			logUsage(t, db, fmt.Sprintf("r%04d", n), keys[n%len(keys)], ips[n%len(ips)],
				10*n, float64(n)/4, day.Add(time.Duration(i)*time.Hour+30*time.Minute))
		}
	}

	scopes := []UsageFilter{
		{Scope: "global", ScopeValue: "*"},
		{Scope: "api_key", ScopeValue: "k-alpha"},
		{Scope: "api_key", ScopeValue: "k-loose"},
		{Scope: "api_key", ScopeValue: ""},
		{Scope: "api_key", ScopeValue: "k-nobody"},
		{Scope: "ip", ScopeValue: "10.0.0.1"},
		{Scope: "ip", ScopeValue: "unknown"},
		{Scope: "ip", ScopeValue: "10.9.9.9"},
		{Scope: "team", ScopeValue: "alpha"},
		{Scope: "team", ScopeValue: "beta"},
		{Scope: "team", ScopeValue: "unassigned"},
		{Scope: "team", ScopeValue: "nobody"},
	}
	starts := []time.Time{
		today,
		today.AddDate(0, 0, -1),
		today.AddDate(0, 0, -3),
		today.AddDate(0, 0, -30),
		time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, seoulZone),
	}

	usedFastPath := false
	for _, filter := range scopes {
		for _, since := range starts {
			filter.Since = since
			wantReq, wantCost, wantTokens, err := db.UsageSince(ctx, filter)
			if err != nil {
				t.Fatalf("exact %s/%s: %v", filter.Scope, filter.ScopeValue, err)
			}
			gotReq, gotCost, gotTokens, err := db.UsageForPeriod(ctx, filter)
			if err != nil {
				t.Fatalf("rollup %s/%s: %v", filter.Scope, filter.ScopeValue, err)
			}
			if gotReq != wantReq || gotTokens != wantTokens || !nearlyEqual(gotCost, wantCost) {
				t.Errorf("%s/%s since %s: rollup says (%d req, %.4f krw, %d tokens), the exact aggregate says (%d, %.4f, %d)",
					filter.Scope, filter.ScopeValue, since.Format(time.RFC3339),
					gotReq, gotCost, gotTokens, wantReq, wantCost, wantTokens)
			}
			if db.rollupCovers(ctx, since) {
				usedFastPath = true
			}
		}
	}
	if !usedFastPath {
		t.Fatal("every comparison fell back to the exact aggregate, so the day totals were never exercised")
	}
}

func nearlyEqual(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-6
}

// A fresh database has no uncounted traffic, so its totals are complete from the start and
// a quota can be enforced from them on day one rather than after the first period rolls.
func TestAFreshDatabaseIsCoveredImmediately(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)
	if !db.rollupCovers(ctx, today) {
		t.Fatal("a database that had no requests when the totals were introduced is not covered")
	}
	if !db.rollupCovers(ctx, today.AddDate(0, -6, 0)) {
		t.Fatal("a fresh database should be covered for any period, having no earlier traffic")
	}
}

// A database that already holds traffic cannot claim its totals cover the period in
// progress, because the earlier part of that period was never counted.
func TestAnUpgradedDatabaseIsNotCoveredForThePeriodInProgress(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)

	// Traffic that predates the totals, then the marker taken as if on upgrade.
	logUsage(t, db, "old", "k1", "10.0.0.1", 100, 1, today.Add(time.Hour))
	if _, err := db.db.ExecContext(ctx, db.bind(`DELETE FROM usage_rollup_state`)); err != nil {
		t.Fatal(err)
	}
	db.rollupStart = rollupStart{}
	if err := db.markUsageRollupStarted(ctx); err != nil {
		t.Fatal(err)
	}

	if db.rollupCovers(ctx, today) {
		t.Fatal("today's period began before the totals existed, so it must not be answered from them")
	}
	if !db.rollupCovers(ctx, today.AddDate(0, 0, 1)) {
		t.Fatal("a period beginning after the totals started must be covered")
	}
}

// Summing whole days can only answer a question that starts on a day boundary. Anything
// else has to go to the exact aggregate, or a quota would count traffic from before its
// period began.
func TestAnUnalignedStartIsNotAnsweredFromDayTotals(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)
	for _, since := range []time.Time{
		today.Add(time.Hour),
		today.Add(time.Second),
		today.Add(time.Nanosecond),
		today.In(time.UTC), // same instant, still KST midnight
	} {
		covered := db.rollupCovers(ctx, since)
		wantCovered := since.Equal(today)
		if covered != wantCovered {
			t.Errorf("since %s: covered=%v want %v", since.Format(time.RFC3339Nano), covered, wantCovered)
		}
	}
}

// Retention deletes traffic, and the chosen behaviour is that deleted traffic stops
// counting against a quota — the same as before the day totals existed. The two paths have
// to still agree afterwards, including for the day the cutoff falls in, which is only
// partly deleted.
func TestUsageForPeriodStillAgreesAfterRetention(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{
		ID: "k1", Name: "k1", KeyHash: "h1", Owner: "o", Team: "alpha",
		Status: "active", CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}

	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)

	// The cutoff PurgeOlderThan will use. Rows are placed around it deliberately: the day
	// it falls in has to end up part deleted and part kept, or the rebuild of that day is
	// never exercised and the test passes for the wrong reason.
	const retentionDays = 3
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays)

	n := 0
	add := func(when time.Time) {
		n++
		logUsage(t, db, fmt.Sprintf("r%03d", n), "k1", "10.0.0.1", 10*n, float64(n), when)
	}
	for dayOffset := 0; dayOffset < 6; dayOffset++ {
		day := today.AddDate(0, 0, -dayOffset)
		for hour := 1; hour < 23; hour += 4 {
			add(day.Add(time.Duration(hour) * time.Hour))
		}
	}
	// Straddle the cutoff instant itself, so its day is split whatever time of day the
	// test runs at.
	add(cutoff.Add(-time.Minute))
	add(cutoff.Add(-time.Second))
	add(cutoff.Add(time.Second))
	add(cutoff.Add(time.Minute))

	cutoffDayStart := time.Date(cutoff.In(seoulZone).Year(), cutoff.In(seoulZone).Month(), cutoff.In(seoulZone).Day(), 0, 0, 0, 0, seoulZone)
	countCutoffDay := func() int64 {
		t.Helper()
		var c int64
		if err := db.db.QueryRowContext(ctx,
			db.bind(`SELECT COUNT(*) FROM request_logs WHERE created_at >= ? AND created_at < ?`),
			formatTime(cutoffDayStart.UTC()), formatTime(cutoffDayStart.Add(24*time.Hour).UTC())).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	cutoffDayBefore := countCutoffDay()

	if _, err := db.PurgeOlderThan(ctx, "request_logs", retentionDays); err != nil {
		t.Fatal(err)
	}

	cutoffDayAfter := countCutoffDay()
	if cutoffDayAfter == 0 || cutoffDayAfter == cutoffDayBefore {
		t.Fatalf("the cutoff day went from %d rows to %d; the test needs it partly purged so the "+
			"rebuild of that day is exercised", cutoffDayBefore, cutoffDayAfter)
	}

	for _, filter := range []UsageFilter{
		{Scope: "global", ScopeValue: "*"},
		{Scope: "api_key", ScopeValue: "k1"},
		{Scope: "ip", ScopeValue: "10.0.0.1"},
		{Scope: "team", ScopeValue: "alpha"},
	} {
		for _, since := range []time.Time{today, today.AddDate(0, 0, -5), today.AddDate(0, 0, -30)} {
			filter.Since = since
			wantReq, wantCost, wantTokens, err := db.UsageSince(ctx, filter)
			if err != nil {
				t.Fatal(err)
			}
			gotReq, gotCost, gotTokens, err := db.UsageForPeriod(ctx, filter)
			if err != nil {
				t.Fatal(err)
			}
			if gotReq != wantReq || gotTokens != wantTokens || !nearlyEqual(gotCost, wantCost) {
				t.Errorf("after retention, %s/%s since %s: rollup (%d, %.4f, %d) vs exact (%d, %.4f, %d)",
					filter.Scope, filter.ScopeValue, since.Format("2006-01-02"),
					gotReq, gotCost, gotTokens, wantReq, wantCost, wantTokens)
			}
		}
	}

	// And the purge really did remove something, or the comparison above proves nothing.
	var remaining int64
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM request_logs`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining == 0 || remaining == int64(n) {
		t.Fatalf("retention removed %d of %d rows; the test needs a partial purge", int64(n)-remaining, n)
	}
}

// The day totals are written in the same transaction as the request. A request that fails
// to log must not leave its usage counted, or a quota would charge for traffic that has no
// record.
func TestRollupIsWrittenWithTheRequestOrNotAtAll(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)

	logUsage(t, db, "dup", "k1", "10.0.0.1", 100, 1, today.Add(time.Hour))
	before, _, beforeTokens, err := db.UsageForPeriod(ctx, UsageFilter{Scope: "api_key", ScopeValue: "k1", Since: today})
	if err != nil {
		t.Fatal(err)
	}

	// The same id again: request_logs rejects it, so nothing about the transaction may
	// survive — including the usage.
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "dup", TraceID: "dup", APIKeyID: "k1", ClientIP: "10.0.0.1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: today.Add(2 * time.Hour)},
		Usage: &TokenUsage{ID: "u2", RequestID: "dup", TotalTokens: 999, EstimatedCost: 99, CreatedAt: today},
	}); err == nil {
		t.Fatal("a duplicate request id was accepted; this test needs it to fail")
	}

	after, _, afterTokens, err := db.UsageForPeriod(ctx, UsageFilter{Scope: "api_key", ScopeValue: "k1", Since: today})
	if err != nil {
		t.Fatal(err)
	}
	if after != before || afterTokens != beforeTokens {
		t.Fatalf("a rolled-back request still counted: %d req/%d tokens before, %d/%d after",
			before, beforeTokens, after, afterTokens)
	}
}

// A cost that is not a number must contribute nothing rather than poison the total. SQLite
// stores a non-finite float as NULL, which these columns forbid, and a running total that
// once became NaN would stay NaN for every later request in that scope.
func TestANonFiniteCostDoesNotPoisonTheTotals(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)

	logUsage(t, db, "good", "k1", "10.0.0.1", 10, 5, today.Add(time.Hour))
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "bad", TraceID: "bad", APIKeyID: "k1", ClientIP: "10.0.0.1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: today.Add(2 * time.Hour)},
		Usage: &TokenUsage{ID: "ubad", RequestID: "bad", TotalTokens: 7,
			EstimatedCost: math.Inf(1), CreatedAt: today.Add(2 * time.Hour)},
	}); err != nil {
		t.Fatalf("a request with a non-finite cost could not be logged: %v", err)
	}
	logUsage(t, db, "after", "k1", "10.0.0.1", 10, 5, today.Add(3*time.Hour))

	filter := UsageFilter{Scope: "api_key", ScopeValue: "k1", Since: today}
	requests, cost, tokens, err := db.UsageForPeriod(ctx, filter)
	if err != nil {
		t.Fatal(err)
	}
	if math.IsNaN(cost) || math.IsInf(cost, 0) {
		t.Fatalf("the running cost total is %v; one bad request has broken every later one", cost)
	}
	if requests != 3 || tokens != 27 {
		t.Fatalf("got %d requests / %d tokens, want 3 / 27", requests, tokens)
	}

	wantReq, wantCost, wantTokens, err := db.UsageSince(ctx, filter)
	if err != nil {
		t.Fatal(err)
	}
	if requests != wantReq || tokens != wantTokens || !nearlyEqual(cost, wantCost) {
		t.Fatalf("rollup (%d, %v, %d) disagrees with the exact aggregate (%d, %v, %d)",
			requests, cost, tokens, wantReq, wantCost, wantTokens)
	}
}
