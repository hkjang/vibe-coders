package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/workintel"
)

// The fixture every aggregate test below is computed against by hand. Two
// Seoul days: day one is 2026-11-10, day two starts at 15:00 UTC.
var (
	workDay1 = "2026-11-10"
	workDay2 = "2026-11-11"
	workT0   = time.Date(2026, 11, 10, 1, 0, 0, 0, time.UTC) // 10:00 in Seoul
)

type workSeed struct {
	id, key, session, model, provider string
	status                            int
	latency                           int64
	fingerprint                       string
	at                                time.Time
	tokensIn, tokensOut               int
	cost                              float64
	endpoint                          string
	dlp                               bool

	// The classification the test assigns; the store does not classify.
	category, action, method, state string
	confidence                      float64
	needsLLM                        bool
}

// workFixture is eight requests in ingestion order. Session S1 switches
// models twice and retries once after an error, and does two kinds of work;
// S3 belongs to another team, crosses midnight in Seoul and ends in an error;
// the last request has no session at all.
func workFixture() []workSeed {
	at := func(minutes int) time.Time { return workT0.Add(time.Duration(minutes) * time.Minute) }
	return []workSeed{
		{id: "r1", key: "kA1", session: "S1", model: "m1", provider: "p1", status: 200, latency: 400, fingerprint: "fpA", at: at(0), tokensIn: 10, tokensOut: 5, cost: 1.0,
			category: "dev.codegen", action: "create", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.80},
		{id: "r2", key: "kA1", session: "S1", model: "m2", provider: "p1", status: 500, latency: 900, fingerprint: "fpB", at: at(1), tokensIn: 20, tokensOut: 0, cost: 0.5,
			category: "dev.codegen", action: "create", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.80},
		{id: "r3", key: "kA1", session: "S1", model: "m2", provider: "p1", status: 200, latency: 1500, fingerprint: "fpB", at: at(2), tokensIn: 20, tokensOut: 8, cost: 0.25,
			category: "infra.k8s", action: "analyze", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.55, needsLLM: true},
		{id: "r4", key: "kA1", session: "S1", model: "m1", provider: "p1", status: 200, latency: 6000, fingerprint: "fpC", at: at(3), tokensIn: 30, tokensOut: 10, cost: 2.0,
			category: "dev.codegen", action: "create", method: workintel.MethodLLM, state: workintel.StatusClassified, confidence: 0.95},
		{id: "r5", key: "kA2", session: "S2", model: "m1", provider: "p1", status: 200, latency: 100, fingerprint: "fpA", at: at(4), tokensIn: 5, tokensOut: 5, cost: 0.25,
			category: "dev.codegen", action: "create", method: workintel.MethodRule, state: workintel.StatusReview, confidence: 0.45},
		{id: "r6", key: "kB1", session: "S3", model: "m3", provider: "p2", status: 200, latency: 70000, at: workT0.Add(13*time.Hour + 30*time.Minute), tokensIn: 100, tokensOut: 50, cost: 4.0,
			category: "other", action: "unknown", method: workintel.MethodRule, state: workintel.StatusUnclassified, confidence: 0, needsLLM: true},
		{id: "r7", key: "kB1", session: "S3", model: "m3", provider: "p2", status: 429, latency: 50, fingerprint: "fpZ", at: workT0.Add(14*time.Hour + 30*time.Minute), tokensIn: 1, tokensOut: 0, cost: 0, dlp: true,
			category: "data.sql", action: "read", method: workintel.MethodCache, state: workintel.StatusClassified, confidence: 0.90},
		{id: "r8", key: "kB1", session: "", model: "m3", provider: "p2", status: 200, latency: 500, fingerprint: "fpZ", at: workT0.Add(15 * time.Hour), tokensIn: 2, tokensOut: 2, cost: 0.5,
			category: "data.sql", action: "read", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.6},
	}
}

func seedWorkKeys(t *testing.T, db *SQLStore) {
	t.Helper()
	for _, k := range []APIKeyRecord{
		{ID: "kA1", Name: "kA1", KeyHash: "hash-kA1", Team: "alpha", UserID: "u1"},
		{ID: "kA2", Name: "kA2", KeyHash: "hash-kA2", Team: "alpha"},
		{ID: "kB1", Name: "kB1", KeyHash: "hash-kB1", Team: "beta", UserID: "u9"},
	} {
		if err := db.UpsertAPIKey(context.Background(), k); err != nil {
			t.Fatal(err)
		}
	}
}

func seedWorkRequest(t *testing.T, db *SQLStore, s workSeed) {
	t.Helper()
	endpoint := s.endpoint
	if endpoint == "" {
		endpoint = "/v1/chat/completions"
	}
	rec := LogRecord{
		Request: RequestLog{ID: s.id, TraceID: "trace_" + s.id, APIKeyID: s.key, UserAgent: "claude-cli/1.0", Model: s.model,
			Provider: s.provider, Endpoint: endpoint, StatusCode: s.status, LatencyMS: s.latency, SessionID: s.session,
			TaskType: "generate", PromptFingerprint: s.fingerprint, CreatedAt: s.at},
		Prompts: []PromptLog{{ID: "p_" + s.id, RequestID: s.id, Role: "user", RedactedText: "prompt of " + s.id, CreatedAt: s.at}},
		Usage: &TokenUsage{ID: "u_" + s.id, RequestID: s.id, PromptTokens: s.tokensIn, CompletionTokens: s.tokensOut,
			TotalTokens: s.tokensIn + s.tokensOut, EstimatedCost: s.cost, Currency: "KRW", Source: "usage", CreatedAt: s.at},
	}
	if s.dlp {
		rec.DLPEvents = []DLPEvent{{ID: "dlp_" + s.id, Check: "request", Action: "mask", ProfileID: "pii"}}
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

// classifyWorkFixture turns the requests a batch read returned into facts
// with the classification the fixture assigns.
func classifyWorkFixture(t *testing.T, requests []WorkIntelRequest, seeds []workSeed) []WorkClassification {
	t.Helper()
	byID := map[string]workSeed{}
	for _, s := range seeds {
		byID[s.id] = s
	}
	out := make([]WorkClassification, 0, len(requests))
	for _, r := range requests {
		s, ok := byID[r.RequestID]
		if !ok {
			t.Fatalf("batch returned an unknown request %q", r.RequestID)
		}
		fact := r.Fact()
		fact.SetResult(workintel.Result{CategoryID: s.category, TopCategoryID: workTopCategory(s.category), ActionType: s.action,
			Confidence: s.confidence, Method: s.method, Status: s.state, Tags: []string{}, Technologies: []string{}}, 1, "")
		fact.NeedsLLM = s.needsLLM
		out = append(out, fact)
	}
	return out
}

// applyWorkFixture seeds the fixture and applies it in two batches (two
// requests, then the rest), so the second batch depends on the session state
// the first one stored. It returns the cursor before the second batch.
func applyWorkFixture(t *testing.T, db *SQLStore) (beforeSecond, end WorkIntelCursor, second []WorkClassification) {
	t.Helper()
	ctx := context.Background()
	seedWorkKeys(t, db)
	start, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	seeds := workFixture()
	for _, s := range seeds {
		seedWorkRequest(t, db, s)
	}
	first, cursor1, err := db.WorkIntelBatch(ctx, start, 2, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].RequestID != "r1" || first[1].RequestID != "r2" {
		t.Fatalf("first batch = %+v, want r1 and r2 in ingestion order", first)
	}
	if res, err := db.ApplyWorkIntelBatch(ctx, classifyWorkFixture(t, first, seeds), start, cursor1); err != nil || res.Inserted != 2 {
		t.Fatalf("apply first batch: %+v, %v", res, err)
	}
	rest, cursor2, err := db.WorkIntelBatch(ctx, cursor1, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 6 {
		t.Fatalf("second batch has %d requests, want 6", len(rest))
	}
	second = classifyWorkFixture(t, rest, seeds)
	res, err := db.ApplyWorkIntelBatch(ctx, second, cursor1, cursor2)
	if err != nil || res.Inserted != 6 || res.Existing != 0 {
		t.Fatalf("apply second batch: %+v, %v", res, err)
	}
	if !reflect.DeepEqual(res.Days, []string{workDay1, workDay2}) {
		t.Fatalf("days touched = %v", res.Days)
	}
	return cursor1, cursor2, second
}

// workDump reads a table as text, one string per row, in a fixed order. It is
// how two states of the aggregates are compared.
func workDump(t *testing.T, db *SQLStore, query string) []string {
	t.Helper()
	rows, err := db.db.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []string{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		parts := make([]string, len(cols))
		for i, v := range values {
			switch x := v.(type) {
			case []byte:
				parts[i] = string(x)
			case float64:
				// Sums of the same numbers added in a different order may differ
				// in the last bits.
				parts[i] = strconv.FormatFloat(math.Round(x*1e6)/1e6, 'f', -1, 64)
			default:
				parts[i] = fmt.Sprint(x)
			}
		}
		out = append(out, strings.Join(parts, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

const (
	workDumpDaily = `SELECT day, category_id, action_type, team, model, provider, client, top_category_id, requests, tokens_in, tokens_out,
		cost_krw, mcp_calls, errors, retries, latency_ms, lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7,
		m_rule, m_llm, m_cache, m_manual, s_review, s_unclassified, s_failed, conf_b0, conf_b1, conf_b2, conf_b3, conf_b4
		FROM work_daily ORDER BY day, category_id, action_type, team, model, provider, client`
	workDumpUsers = `SELECT day, category_id, team, user_key, top_category_id FROM work_daily_users ORDER BY day, category_id, team, user_key`
	// updated_at is left out: a rebuild writes the same row at a later time.
	workDumpSessions = `SELECT session_id, team, session_kind, user_key, client, day, first_at, last_at, requests, mcp_calls, tokens_in,
		tokens_out, cost_krw, latency_ms, errors, retries, models, model_switches, last_model, last_fingerprint, last_error,
		last_ingested_at, policy_flags, positive_feedback, completion, category_counts, primary_category_id, primary_top_category_id
		FROM work_sessions ORDER BY session_id, team`
	workDumpSegments = `SELECT session_id, team, category_id, day, top_category_id, user_key, client, first_at, last_at, requests,
		tokens_in, tokens_out, cost_krw, mcp_calls, errors, latency_ms
		FROM work_session_segments ORDER BY session_id, team, category_id, day`
)

func workAggregates(t *testing.T, db *SQLStore) map[string][]string {
	t.Helper()
	return map[string][]string{
		"work_daily":            workDump(t, db, workDumpDaily),
		"work_daily_users":      workDump(t, db, workDumpUsers),
		"work_sessions":         workDump(t, db, workDumpSessions),
		"work_session_segments": workDump(t, db, workDumpSegments),
	}
}

func requireSameAggregates(t *testing.T, what string, want, got map[string][]string) {
	t.Helper()
	for table, rows := range want {
		if !reflect.DeepEqual(rows, got[table]) {
			t.Errorf("%s: %s differs\nwant:\n  %s\ngot:\n  %s", what, table, strings.Join(rows, "\n  "), strings.Join(got[table], "\n  "))
		}
	}
}

func TestWorkIntelBatchAggregatesMatchHandComputedFixture(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)

	facts, err := db.WorkClassificationsByID(ctx, []string{"r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"})
	if err != nil || len(facts) != 8 {
		t.Fatalf("facts = %d, %v", len(facts), err)
	}
	byID := map[string]WorkClassification{}
	for _, f := range facts {
		byID[f.RequestID] = f
	}
	// Team and user come from the API key; the key stands in for a user it
	// does not have.
	if f := byID["r1"]; f.Team != "alpha" || f.UserKey != "u1" || f.Client != "Claude Code" || f.Day != workDay1 || f.SessionKind != workintel.SessionExplicit {
		t.Errorf("r1 = %+v", f)
	}
	if f := byID["r5"]; f.Team != "alpha" || f.UserKey != "kA2" {
		t.Errorf("r5 team/user = %q/%q, want alpha/kA2", f.Team, f.UserKey)
	}
	if f := byID["r7"]; f.Day != workDay2 || !f.IsError || !reflect.DeepEqual(f.PolicyFlags, []string{WorkFlagDLP}) || f.TokensIn != 1 {
		t.Errorf("r7 = %+v", f)
	}
	if f := byID["r6"]; f.Day != workDay1 {
		t.Errorf("r6 day = %s: 23:30 in Seoul still belongs to %s", f.Day, workDay1)
	}
	// Only r3 repeats the fingerprint of the failed request right before it.
	for id, f := range byID {
		if f.IsRetry != (id == "r3") {
			t.Errorf("%s is_retry = %v", id, f.IsRetry)
		}
	}
	if f := byID["r8"]; f.SessionID != "" || f.SessionKind != workintel.SessionUnknown {
		t.Errorf("r8 session = %q/%q", f.SessionID, f.SessionKind)
	}

	// day | category | action | team | model | provider | client | top | requests | in | out | cost | mcp | errors | retries |
	// latency | lat_b0..7 | rule llm cache manual | review unclassified failed | conf_b0..4
	wantDaily := []string{
		"2026-11-10|dev.codegen|create|alpha|m1|p1|Claude Code|dev|3|45|20|3.25|0|0|0|6500|2|0|0|0|1|0|0|0|2|1|0|0|1|0|0|1|0|0|1|1",
		"2026-11-10|dev.codegen|create|alpha|m2|p1|Claude Code|dev|1|20|0|0.5|0|1|0|900|0|1|0|0|0|0|0|0|1|0|0|0|0|0|0|0|0|0|1|0",
		"2026-11-10|infra.k8s|analyze|alpha|m2|p1|Claude Code|infra|1|20|8|0.25|0|0|1|1500|0|0|1|0|0|0|0|0|1|0|0|0|0|0|0|0|1|0|0|0",
		"2026-11-10|other|unknown|beta|m3|p2|Claude Code|other|1|100|50|4|0|0|0|70000|0|0|0|0|0|0|0|1|1|0|0|0|0|1|0|1|0|0|0|0",
		"2026-11-11|data.sql|read|beta|m3|p2|Claude Code|data|2|3|2|0.5|0|1|0|550|2|0|0|0|0|0|0|0|1|0|1|0|0|0|0|0|0|1|0|1",
	}
	if got := workDump(t, db, workDumpDaily); !reflect.DeepEqual(got, wantDaily) {
		t.Errorf("work_daily\nwant:\n  %s\ngot:\n  %s", strings.Join(wantDaily, "\n  "), strings.Join(got, "\n  "))
	}
	wantUsers := []string{
		"2026-11-10|dev.codegen|alpha|kA2|dev",
		"2026-11-10|dev.codegen|alpha|u1|dev",
		"2026-11-10|infra.k8s|alpha|u1|infra",
		"2026-11-10|other|beta|u9|other",
		"2026-11-11|data.sql|beta|u9|data",
	}
	if got := workDump(t, db, workDumpUsers); !reflect.DeepEqual(got, wantUsers) {
		t.Errorf("work_daily_users\nwant:\n  %s\ngot:\n  %s", strings.Join(wantUsers, "\n  "), strings.Join(got, "\n  "))
	}

	// session | team | requests | in | out | cost | latency | errors | retries | models | switches | last_model | last_fp |
	// last_error | flags | completion | counts | primary | primary_top | day
	wantSessions := []string{
		`S1|alpha|4|80|23|3.75|8800|1|1|["m1","m2"]|2|m1|fpC|0||unknown|{"dev.codegen":3,"infra.k8s":1}|dev.codegen|dev|2026-11-10`,
		`S2|alpha|1|5|5|0.25|100|0|0|["m1"]|0|m1|fpA|0||unknown|{"dev.codegen":1}|dev.codegen|dev|2026-11-10`,
		// The day is the day the session began; a tie in the counts goes to the smaller id.
		`S3|beta|2|101|50|4|70050|1|0|["m3"]|0|m3|fpZ|1|dlp|ended_with_error|{"data.sql":1,"other":1}|data.sql|data|2026-11-10`,
	}
	gotSessions := workDump(t, db, `SELECT session_id, team, requests, tokens_in, tokens_out, cost_krw, latency_ms, errors, retries, models,
		model_switches, last_model, last_fingerprint, last_error, policy_flags, completion, category_counts, primary_category_id,
		primary_top_category_id, day FROM work_sessions ORDER BY session_id, team`)
	if !reflect.DeepEqual(gotSessions, wantSessions) {
		t.Errorf("work_sessions\nwant:\n  %s\ngot:\n  %s", strings.Join(wantSessions, "\n  "), strings.Join(gotSessions, "\n  "))
	}

	// session | team | category | day | top | user | requests | in | out | cost | errors | latency
	wantSegments := []string{
		"S1|alpha|dev.codegen|2026-11-10|dev|u1|3|60|15|3.5|1|7300",
		"S1|alpha|infra.k8s|2026-11-10|infra|u1|1|20|8|0.25|0|1500",
		"S2|alpha|dev.codegen|2026-11-10|dev|kA2|1|5|5|0.25|0|100",
		"S3|beta|data.sql|2026-11-11|data|u9|1|1|0|0|1|50",
		"S3|beta|other|2026-11-10|other|u9|1|100|50|4|0|70000",
	}
	gotSegments := workDump(t, db, `SELECT session_id, team, category_id, day, top_category_id, user_key, requests, tokens_in, tokens_out,
		cost_krw, errors, latency_ms FROM work_session_segments ORDER BY session_id, team, category_id, day`)
	if !reflect.DeepEqual(gotSegments, wantSegments) {
		t.Errorf("work_session_segments\nwant:\n  %s\ngot:\n  %s", strings.Join(wantSegments, "\n  "), strings.Join(gotSegments, "\n  "))
	}

	// "Work sessions" of a category are the distinct sessions over its segments.
	var sessions int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT session_id) FROM work_session_segments WHERE top_category_id = 'dev'`).Scan(&sessions); err != nil || sessions != 2 {
		t.Fatalf("work sessions of dev = %d, %v; want 2", sessions, err)
	}
	// The span of a session is first to last request.
	var first, last string
	if err := db.db.QueryRowContext(ctx, `SELECT first_at, last_at FROM work_sessions WHERE session_id = 'S1'`).Scan(&first, &last); err != nil {
		t.Fatal(err)
	}
	if first != workIntelTime(workT0) || last != workIntelTime(workT0.Add(3*time.Minute)) {
		t.Fatalf("S1 span = %s .. %s", first, last)
	}
}

func TestWorkIntelBatchIsAppliedExactlyOnce(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	beforeSecond, end, second := applyWorkFixture(t, db)
	want := workAggregates(t, db)

	// The same batch again from the cursor it was read at: another worker has
	// moved the cursor on, so nothing is written.
	if _, err := db.ApplyWorkIntelBatch(ctx, second, beforeSecond, end); !errors.Is(err, ErrWorkIntelCursorMoved) {
		t.Fatalf("stale apply error = %v, want ErrWorkIntelCursorMoved", err)
	}
	requireSameAggregates(t, "after a stale apply", want, workAggregates(t, db))

	// The same rows again at the current cursor: every fact exists, so only
	// the cursor is written.
	res, err := db.ApplyWorkIntelBatch(ctx, second, end, end)
	if err != nil || res.Inserted != 0 || res.Existing != len(second) {
		t.Fatalf("re-apply = %+v, %v", res, err)
	}
	requireSameAggregates(t, "after re-applying existing facts", want, workAggregates(t, db))

	// The cursor resumes where the last batch ended, and nothing is waiting.
	state, err := db.GetWorkIntelState(ctx)
	if err != nil || state.Cursor != end {
		t.Fatalf("cursor = %+v, %v; want %+v", state.Cursor, err, end)
	}
	rows, next, err := db.WorkIntelBatch(ctx, state.Cursor, 100, 100)
	if err != nil || len(rows) != 0 || next != end {
		t.Fatalf("batch after the end = %d rows, cursor %+v, %v", len(rows), next, err)
	}
	if backlog, _, _, err := db.WorkIntelBacklog(ctx); err != nil || backlog != 0 {
		t.Fatalf("backlog = %d, %v", backlog, err)
	}
	if _, err := db.ApplyWorkIntelBatch(ctx, nil, end, beforeSecond); err == nil {
		t.Fatal("the cursor was allowed to move backwards")
	}
}

// Two workers that read the same batch (a lease that expired mid-cycle) must
// not both count it.
func TestWorkIntelConcurrentAppliesCountOnce(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkKeys(t, db)
	start, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	seeds := workFixture()
	for _, s := range seeds {
		seedWorkRequest(t, db, s)
	}
	requests, end, err := db.WorkIntelBatch(ctx, start, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]error, 4)
	batches := make([][]WorkClassification, len(results))
	for i := range batches {
		batches[i] = classifyWorkFixture(t, requests, seeds)
	}
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = db.ApplyWorkIntelBatch(ctx, batches[i], start, end)
		}(i)
	}
	wg.Wait()
	applied := 0
	for _, err := range results {
		switch {
		case err == nil:
			applied++
		case !errors.Is(err, ErrWorkIntelCursorMoved):
			t.Fatalf("unexpected apply error: %v", err)
		}
	}
	if applied != 1 {
		t.Fatalf("%d of 4 concurrent applies succeeded, want exactly 1", applied)
	}
	var requestsCounted int64
	if err := db.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(requests), 0) FROM work_daily`).Scan(&requestsCounted); err != nil || requestsCounted != 8 {
		t.Fatalf("work_daily counts %d requests, %v; want 8", requestsCounted, err)
	}
}

// A retry is the same prompt sent again right after it failed: not the same
// prompt after a success, not a different prompt after a failure, and never a
// request without a fingerprint.
func TestWorkIntelRetryIsSameFingerprintAfterFailure(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	start, err := db.InitWorkIntelCursor(ctx, workT0)
	if err != nil {
		t.Fatal(err)
	}
	type step struct {
		id, fingerprint string
		failed, retry   bool
	}
	steps := []step{
		{"a", "fpX", false, false},
		{"b", "fpX", false, false}, // same prompt, but the one before succeeded
		{"c", "fpY", true, false},
		{"d", "fpZ", false, false}, // after a failure, but a different prompt
		{"e", "", true, false},
		{"f", "", false, false}, // no fingerprint to compare
		{"g", "fpQ", true, false},
		{"h", "fpQ", true, true},
		{"i", "fpQ", false, true},
		{"j", "fpQ", false, false}, // the retry before it succeeded
	}
	facts := make([]WorkClassification, 0, len(steps))
	for i, st := range steps {
		at := workT0.Add(time.Duration(i) * time.Second)
		facts = append(facts, WorkClassification{RequestID: st.id, CreatedAt: workIntelTime(at), IngestedAt: workIntelTime(at), SessionID: "S", Team: "alpha",
			UserKey: "u1", Model: "m1", CategoryID: "dev", Fingerprint: st.fingerprint, IsError: st.failed})
	}
	// Two batches, split inside the run of retries: the decision has to carry
	// over through the stored session head.
	mid, end := WorkIntelCursor{IngestedAt: facts[7].IngestedAt, RequestID: "h"}, WorkIntelCursor{IngestedAt: facts[9].IngestedAt, RequestID: "j"}
	if _, err := db.ApplyWorkIntelBatch(ctx, facts[:8], start, mid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ApplyWorkIntelBatch(ctx, facts[8:], mid, end); err != nil {
		t.Fatal(err)
	}
	stored, err := db.WorkClassificationsByID(ctx, []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"})
	if err != nil || len(stored) != len(steps) {
		t.Fatalf("stored %d facts, %v", len(stored), err)
	}
	got := map[string]bool{}
	for _, f := range stored {
		got[f.RequestID] = f.IsRetry
	}
	for _, st := range steps {
		if got[st.id] != st.retry {
			t.Errorf("%s (fingerprint %q, failed %v): is_retry = %v, want %v", st.id, st.fingerprint, st.failed, got[st.id], st.retry)
		}
	}
	if head := workDump(t, db, `SELECT requests, errors, retries, completion FROM work_sessions`); !reflect.DeepEqual(head, []string{"10|4|2|unknown"}) {
		t.Errorf("session head = %v", head)
	}
	if daily := workDump(t, db, `SELECT requests, errors, retries FROM work_daily`); !reflect.DeepEqual(daily, []string{"10|4|2"}) {
		t.Errorf("work_daily = %v", daily)
	}
	// The rebuild replays the stored decisions and reaches the same state.
	want := workAggregates(t, db)
	if _, err := db.RebuildWorkDays(ctx, []string{workDay1}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RebuildWorkSessions(ctx, []string{"S"}); err != nil {
		t.Fatal(err)
	}
	requireSameAggregates(t, "after a rebuild", want, workAggregates(t, db))

	// A fact older than what the session has seen cannot be placed by the
	// incremental path; the session is marked and the rebuild puts it right.
	late := WorkClassification{RequestID: "late", CreatedAt: workIntelTime(workT0.Add(-time.Minute)), IngestedAt: workIntelTime(workT0.Add(-time.Minute)),
		SessionID: "S", Team: "alpha", UserKey: "u1", Model: "m2", CategoryID: "dev", Fingerprint: "fpQ"}
	if _, err := db.ApplyWorkIntelBatch(ctx, []WorkClassification{late}, end, end); err != nil {
		t.Fatal(err)
	}
	if _, sessions, _ := db.WorkIntelDirty(ctx, 10); !reflect.DeepEqual(sessions, []string{"S"}) {
		t.Fatalf("an out-of-order fact did not mark its session: %v", sessions)
	}
	if _, err := db.RebuildWorkIntelDirty(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if head := workDump(t, db, `SELECT requests, model_switches, models, last_model, first_at FROM work_sessions`); !reflect.DeepEqual(head, []string{`11|1|["m2","m1"]|m1|` + late.CreatedAt}) {
		t.Errorf("session head after the rebuild = %v", head)
	}
}

func TestWorkIntelRebuildEqualsIncrementalState(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)
	want := workAggregates(t, db)

	// Break every aggregate, then rebuild from the facts.
	for _, stmt := range []string{
		`UPDATE work_daily SET requests = requests + 7, cost_krw = 0, conf_b0 = 9`,
		`DELETE FROM work_daily_users WHERE user_key = 'u1'`,
		`UPDATE work_sessions SET requests = 0, model_switches = 9, completion = 'confirmed', category_counts = '{}'`,
		`DELETE FROM work_session_segments WHERE category_id = 'infra.k8s'`,
		`UPDATE work_session_segments SET requests = 99`,
	} {
		if _, err := db.db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	res, err := db.RebuildWorkDays(ctx, []string{workDay1, workDay2, workDay1})
	if err != nil || !reflect.DeepEqual(res.Days, []string{workDay1, workDay2}) || len(res.SkippedDays) != 0 {
		t.Fatalf("rebuild days = %+v, %v", res, err)
	}
	sessions, err := db.RebuildWorkSessionsOfDays(ctx, []string{workDay1, workDay2})
	if err != nil || sessions.Sessions == 0 {
		t.Fatalf("rebuild sessions = %+v, %v", sessions, err)
	}
	requireSameAggregates(t, "after a rebuild", want, workAggregates(t, db))

	// A rebuild of a day without facts leaves it empty rather than failing.
	if res, err := db.RebuildWorkDays(ctx, []string{"2026-01-01"}); err != nil || len(res.Days) != 1 {
		t.Fatalf("rebuild of an empty day = %+v, %v", res, err)
	}
	if _, err := db.RebuildWorkDays(ctx, []string{"not-a-day"}); err == nil {
		t.Fatal("a malformed day was accepted")
	}
	requireSameAggregates(t, "after rebuilding an empty day", want, workAggregates(t, db))
}

func TestWorkIntelReassignmentRebuildsExactAggregates(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)

	// The semantic step decides r3 was code generation after all.
	change := WorkClassificationChange{RequestID: "r3"}
	change.SetResult(workintel.Result{CategoryID: "dev.codegen", TopCategoryID: "dev", ActionType: "create", Confidence: 0.9,
		Method: workintel.MethodLLM, Status: workintel.StatusClassified, Tags: []string{"태그"}, Technologies: []string{"Go"}, WorkTitle: "코드 생성"}, 2, "judge-model")
	res, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{change, {RequestID: "missing", Reassign: true, CategoryID: "dev"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Updated != 1 || res.Reassigned != 1 || res.Missing != 1 || !reflect.DeepEqual(res.Days, []string{workDay1}) || !reflect.DeepEqual(res.SessionIDs, []string{"S1"}) {
		t.Fatalf("reassign result = %+v", res)
	}
	fact, _ := db.WorkClassificationsByID(ctx, []string{"r3"})
	if len(fact) != 1 || fact[0].CategoryID != "dev.codegen" || fact[0].Method != workintel.MethodLLM || fact[0].PolicyVersion != 2 ||
		fact[0].ClassifierModel != "judge-model" || fact[0].NeedsLLM || !fact[0].IsRetry || fact[0].WorkTitle != "코드 생성" || !reflect.DeepEqual(fact[0].Tags, []string{"태그"}) {
		t.Fatalf("r3 after reassignment = %+v", fact)
	}
	// The aggregates are stale until the rebuild, and the marks say which.
	days, sessionIDs, err := db.WorkIntelDirty(ctx, 10)
	if err != nil || !reflect.DeepEqual(days, []string{workDay1}) || !reflect.DeepEqual(sessionIDs, []string{"S1"}) {
		t.Fatalf("dirty = %v %v, %v", days, sessionIDs, err)
	}
	rebuilt, err := db.RebuildWorkIntelDirty(ctx, 10)
	if err != nil || !reflect.DeepEqual(rebuilt.Days, []string{workDay1}) || rebuilt.Sessions != 1 {
		t.Fatalf("rebuild dirty = %+v, %v", rebuilt, err)
	}
	if days, sessionIDs, _ := db.WorkIntelDirty(ctx, 10); len(days)+len(sessionIDs) != 0 {
		t.Fatalf("marks left after the rebuild: %v %v", days, sessionIDs)
	}

	gotDaily := workDump(t, db, `SELECT category_id, action_type, model, requests, retries, m_rule, m_llm, conf_b1, conf_b3, conf_b4
		FROM work_daily WHERE day = '2026-11-10' AND team = 'alpha' ORDER BY category_id, action_type, model`)
	wantDaily := []string{
		"dev.codegen|create|m1|3|0|2|1|0|1|1",
		// r2 and r3 now share a row: the retry moved with r3, and 0.9 falls in the top bucket.
		"dev.codegen|create|m2|2|1|1|1|0|1|1",
	}
	if !reflect.DeepEqual(gotDaily, wantDaily) {
		t.Errorf("work_daily after reassignment\nwant:\n  %s\ngot:\n  %s", strings.Join(wantDaily, "\n  "), strings.Join(gotDaily, "\n  "))
	}
	if users := workDump(t, db, `SELECT category_id, user_key FROM work_daily_users WHERE day = '2026-11-10' AND team = 'alpha' ORDER BY category_id, user_key`); !reflect.DeepEqual(users, []string{"dev.codegen|kA2", "dev.codegen|u1"}) {
		t.Errorf("daily users after reassignment = %v", users)
	}
	if segs := workDump(t, db, `SELECT category_id, requests FROM work_session_segments WHERE session_id = 'S1'`); !reflect.DeepEqual(segs, []string{"dev.codegen|4"}) {
		t.Errorf("S1 segments after reassignment = %v", segs)
	}
	if head := workDump(t, db, `SELECT requests, retries, model_switches, category_counts, primary_category_id FROM work_sessions WHERE session_id = 'S1'`); !reflect.DeepEqual(head, []string{`4|1|2|{"dev.codegen":4}|dev.codegen`}) {
		t.Errorf("S1 head after reassignment = %v", head)
	}

	// A change that no aggregate counts (a new title) marks nothing.
	title := WorkClassificationChange{RequestID: "r1"}
	title.SetResult(workintel.Result{CategoryID: "dev.codegen", TopCategoryID: "dev", ActionType: "create", Confidence: 0.80,
		Method: workintel.MethodRule, Status: workintel.StatusClassified, WorkTitle: "새 제목"}, 1, "")
	if res, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{title}); err != nil || len(res.Days)+len(res.SessionIDs) != 0 || res.Reassigned != 1 {
		t.Fatalf("title-only change = %+v, %v", res, err)
	}
}

func TestWorkIntelManualCorrectionAndAccuracy(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)

	res, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{
		// r5 was "dev.codegen" by rule and is corrected to another category.
		{RequestID: "r5", Reassign: true, CategoryID: "office.mail", TopCategoryID: "office", CorrectedBy: "admin_1", Reason: "메일 작성"},
		// r1 is confirmed as it was: a correction that keeps the category.
		{RequestID: "r1", Reassign: true, CategoryID: "dev.codegen", TopCategoryID: "dev", CorrectedBy: "admin_1"},
	})
	if err != nil || res.Reassigned != 2 {
		t.Fatalf("correct = %+v, %v", res, err)
	}
	facts, _ := db.WorkClassificationsByID(ctx, []string{"r5"})
	if f := facts[0]; f.Method != workintel.MethodManual || f.Confidence != 1 || f.Status != workintel.StatusClassified || f.CorrectedBy != "admin_1" ||
		f.CorrectedAt == "" || f.CategoryID != "office.mail" || f.ActionType != "create" || f.NeedsLLM {
		t.Fatalf("r5 after correction = %+v", f)
	}
	corrections, err := db.ListWorkCorrections(ctx, 10)
	if err != nil || len(corrections) != 2 {
		t.Fatalf("corrections = %+v, %v", corrections, err)
	}
	byRequest := map[string]WorkCorrection{}
	for _, c := range corrections {
		byRequest[c.RequestID] = c
	}
	if c := byRequest["r5"]; c.FromCategoryID != "dev.codegen" || c.ToCategoryID != "office.mail" || c.FromMethod != workintel.MethodRule ||
		c.FromConfidence != 0.45 || c.Actor != "admin_1" || c.Reason != "메일 작성" || c.FromAction != "create" || c.ToAction != "create" {
		t.Fatalf("correction of r5 = %+v", c)
	}
	acc, err := db.WorkMethodAccuracy(ctx, time.Now().Add(-time.Hour))
	if err != nil || acc[workintel.MethodRule] != (workintel.MethodAccuracy{Total: 2, Correct: 1}) {
		t.Fatalf("accuracy = %+v, %v", acc, err)
	}
	if acc, _ := db.WorkMethodAccuracy(ctx, time.Now().Add(time.Hour)); len(acc) != 0 {
		t.Fatalf("accuracy counted corrections older than the window: %+v", acc)
	}

	// A reclassification keeps what an administrator decided.
	keep := WorkClassificationChange{RequestID: "r5", KeepManual: true}
	keep.SetResult(workintel.Result{CategoryID: "dev.codegen", TopCategoryID: "dev", ActionType: "create", Method: workintel.MethodRule, Status: workintel.StatusClassified}, 3, "")
	if res, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{keep}); err != nil || res.SkippedManual != 1 || res.Reassigned != 0 {
		t.Fatalf("reclassify over a manual fact = %+v, %v", res, err)
	}
	if _, err := db.RebuildWorkIntelDirty(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if got := workDump(t, db, `SELECT category_id, requests, m_rule, m_manual, s_review, conf_b0, conf_b4 FROM work_daily
		WHERE day = '2026-11-10' AND team = 'alpha' AND model = 'm1' ORDER BY category_id`); !reflect.DeepEqual(got, []string{
		// r1 (now manual, confidence 1) and r4 (llm, 0.95).
		"dev.codegen|2|0|1|0|0|2",
		"office.mail|1|0|1|0|0|1",
	}) {
		t.Errorf("work_daily after corrections = %v", got)
	}
	if err := db.InsertWorkCorrections(ctx, []WorkCorrection{{RequestID: "r8", FromCategoryID: "a", ToCategoryID: "a", FromMethod: workintel.MethodLLM}}); err != nil {
		t.Fatal(err)
	}
	if acc, _ := db.WorkMethodAccuracy(ctx, time.Now().Add(-time.Hour)); acc[workintel.MethodLLM] != (workintel.MethodAccuracy{Total: 1, Correct: 1}) {
		t.Fatalf("imported correction not counted: %+v", acc)
	}
}

func TestWorkIntelPendingLLMQueue(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)

	pending, err := db.WorkIntelPendingLLM(ctx, 10, 3, 0)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending = %+v, %v", pending, err)
	}
	// Newest first.
	if pending[0].RequestID != "r6" || pending[1].RequestID != "r3" {
		t.Fatalf("pending order = %s, %s", pending[0].RequestID, pending[1].RequestID)
	}
	// A failed try only counts the attempt; nothing an aggregate reads changed.
	fail := []WorkClassificationChange{{RequestID: "r6", NeedsLLM: true, AddLLMAttempts: 1}}
	for i := 0; i < 2; i++ {
		if res, err := db.UpdateWorkClassifications(ctx, fail); err != nil || res.Updated != 1 || res.Reassigned != 0 || len(res.Days) != 0 {
			t.Fatalf("attempt %d = %+v, %v", i, res, err)
		}
	}
	// The least-tried row comes first, whatever its age.
	pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, 0)
	if len(pending) != 2 || pending[0].RequestID != "r3" || pending[1].RequestID != "r6" || pending[1].LLMAttempts != 2 {
		t.Fatalf("pending after two failures = %+v", pending)
	}
	// A row that just failed waits before it is offered again; one that was
	// never tried does not.
	if pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, time.Hour); len(pending) != 1 || pending[0].RequestID != "r3" {
		t.Fatalf("pending inside the backoff = %+v", pending)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE work_classifications SET updated_at = ? WHERE request_id = 'r6'`), workIntelTime(time.Now().Add(-5*time.Hour))); err != nil {
		t.Fatal(err)
	}
	// Two failures wait four times the backoff: five hours ago is past 4h, not past 8h.
	if pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, time.Hour); len(pending) != 2 {
		t.Fatalf("pending after the backoff passed = %+v", pending)
	}
	if pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, 2*time.Hour); len(pending) != 1 {
		t.Fatalf("pending with a longer backoff = %+v", pending)
	}
	if _, err := db.UpdateWorkClassifications(ctx, fail); err != nil {
		t.Fatal(err)
	}
	if pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, 0); len(pending) != 1 || pending[0].RequestID != "r3" {
		t.Fatalf("a row that failed three times is still queued: %+v", pending)
	}
	if pending, _ = db.WorkIntelPendingLLM(ctx, 1, 3, 0); len(pending) != 1 {
		t.Fatalf("limit ignored: %d rows", len(pending))
	}
	// Giving up clears the flag.
	if _, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{{RequestID: "r3", NeedsLLM: false}}); err != nil {
		t.Fatal(err)
	}
	if pending, _ = db.WorkIntelPendingLLM(ctx, 10, 3, 0); len(pending) != 0 {
		t.Fatalf("pending after giving up = %+v", pending)
	}
}

func TestWorkIntelSessionFeedbackConfirmsCompletion(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	applyWorkFixture(t, db)

	if n, err := db.SyncWorkSessionFeedback(ctx, time.Now().Add(-time.Hour)); err != nil || n != 0 {
		t.Fatalf("sync without feedback = %d, %v", n, err)
	}
	for _, fb := range []LLMFeedback{
		{ID: "fb1", RequestID: "r2", TraceID: "trace_r2", Rating: 1, Label: "up", Source: "user"},
		{ID: "fb2", RequestID: "r5", TraceID: "trace_r5", Rating: -1, Label: "down", Source: "user"},
	} {
		if err := db.InsertLLMFeedback(ctx, fb); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := db.SyncWorkSessionFeedback(ctx, time.Now().Add(-time.Hour)); err != nil || n != 1 {
		t.Fatalf("sync = %d, %v; want 1 session confirmed", n, err)
	}
	if n, _ := db.SyncWorkSessionFeedback(ctx, time.Now().Add(-time.Hour)); n != 0 {
		t.Fatalf("second sync confirmed %d sessions again", n)
	}
	want := []string{"S1|confirmed", "S2|unknown", "S3|ended_with_error"}
	if got := workDump(t, db, `SELECT session_id, completion FROM work_sessions ORDER BY session_id`); !reflect.DeepEqual(got, want) {
		t.Fatalf("completion = %v", got)
	}
	// A rebuild finds the same feedback.
	state := workAggregates(t, db)
	if _, err := db.RebuildWorkSessions(ctx, []string{"S1", "S2", "S3", "", "S1"}); err != nil {
		t.Fatal(err)
	}
	requireSameAggregates(t, "after rebuilding confirmed sessions", state, workAggregates(t, db))
}

func TestWorkIntelBatchReadsFeaturesWithoutRawContent(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkKeys(t, db)
	start, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	// The raw column holds something the redacted one does not; it must never
	// be what the worker reads.
	const rawOnly = "RAW-ONLY-CONTENT"
	rec := LogRecord{
		Request: RequestLog{ID: "q1", TraceID: "trace_q1", APIKeyID: "kA1", UserAgent: "Cursor/1.2", Model: "m1", Provider: "p1",
			Endpoint: "/v1/chat/completions", StatusCode: 200, LatencyMS: 10, SessionID: "sess_abc", Complexity: 70, TaskType: "debug",
			PromptFingerprint: "fp1", PolicySummaryJSON: `{"decision":"allow","secret_action":"detect","secret_types":["aws_key"]}`, CreatedAt: now},
		Prompts: []PromptLog{
			{ID: "q1p1", RequestID: "q1", Role: "system", RedactedText: "시스템 지시", CreatedAt: now},
			{ID: "q1p2", RequestID: "q1", Role: "user", RedactedText: "첫 번째 질문", ContentText: rawOnly, CreatedAt: now},
			{ID: "q1p3", RequestID: "q1", Role: "assistant", RedactedText: "답변", CreatedAt: now},
			{ID: "q1p4", RequestID: "q1", Role: "user", RedactedText: "가나다라마바사아자차카타파하", ContentText: rawOnly, CreatedAt: now},
			{ID: "q1p5", RequestID: "q1", Role: "tools", RedactedText: "[tool definitions]", CreatedAt: now},
		},
		Usage: &TokenUsage{ID: "q1u", RequestID: "q1", PromptTokens: 7, CompletionTokens: 3, TotalTokens: 10, EstimatedCost: 1.5, Currency: "KRW", Source: "usage"},
		Languages: []LanguageStat{
			{ID: "q1l1", RequestID: "q1", Language: "Python", Confidence: 0.65},
			{ID: "q1l2", RequestID: "q1", Language: "Go", Confidence: 0.95},
			{ID: "q1l3", RequestID: "q1", Language: "SQL", Confidence: 0.9},
		},
		Tools: []ToolInvocation{
			{ID: "q1t1", RequestID: "q1", TraceID: "trace_q1", ServerLabel: "jira", ToolName: "search_issues", Source: "definition", IsMCP: true},
			{ID: "q1t2", RequestID: "q1", TraceID: "trace_q1", ServerLabel: "github", ToolName: "create_issue", Source: "call", IsMCP: true},
			{ID: "q1t3", RequestID: "q1", TraceID: "trace_q1", ServerLabel: "github", ToolName: "create_issue", Source: "call", IsMCP: true},
			{ID: "q1t4", RequestID: "q1", TraceID: "trace_q1", ToolName: "read_file", Source: "result"},
			{ID: "q1t5", RequestID: "q1", TraceID: "trace_q1", ToolName: "apply_patch", Source: "call"},
		},
		DLPEvents: []DLPEvent{{ID: "q1d", Check: "request", Action: "flag", ProfileID: "pii"}},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLLMFeedback(ctx, LLMFeedback{ID: "q1f", RequestID: "q1", TraceID: "trace_q1", Rating: 1, Label: "up", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	// An embedding request is read (so the cursor passes it) but is not work.
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "q2", TraceID: "trace_q2", APIKeyID: "missing-key", Model: "embed", Endpoint: "/v1/embeddings", StatusCode: 200, CreatedAt: now},
		Prompts: []PromptLog{{ID: "q2p1", RequestID: "q2", Role: "input", RedactedText: "embedding input", CreatedAt: now}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertSecretEvent(ctx, SecretEvent{ID: "q3s", RequestID: "q3", SecretType: "aws_key", Action: "mask"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "q3", TraceID: "trace_q3", Endpoint: "/v1/responses", StatusCode: 400, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	rows, next, err := db.WorkIntelBatch(ctx, start, 10, 5)
	if err != nil || len(rows) != 3 {
		t.Fatalf("batch = %d rows, %v", len(rows), err)
	}
	q1, q2, q3 := rows[0], rows[1], rows[2]
	if next.RequestID != "q3" || next.IngestedAt != q3.IngestedAt {
		t.Fatalf("cursor = %+v", next)
	}
	// Five characters, not five bytes, of the latest user message.
	if q1.Text != "가나다라마" {
		t.Errorf("text = %q, want the first five characters of the latest user prompt", q1.Text)
	}
	if q1.Team != "alpha" || q1.UserKey != "u1" || q1.Client != "Cursor" || q1.TokensIn != 7 || q1.TokensOut != 3 || q1.CostKRW != 1.5 ||
		q1.Complexity != 70 || q1.TaskType != "debug" || q1.Fingerprint != "fp1" || !q1.Classifiable || !q1.PositiveFeedback {
		t.Errorf("q1 = %+v", q1)
	}
	// Confident languages only, most confident first.
	if !reflect.DeepEqual(q1.Languages, []string{"Go", "SQL"}) {
		t.Errorf("languages = %v", q1.Languages)
	}
	// Tools that were called or answered; the declared-only one is left out.
	if !reflect.DeepEqual(q1.MCPServers, []string{"github"}) || !reflect.DeepEqual(q1.MCPTools, []string{"apply_patch", "create_issue", "read_file"}) {
		t.Errorf("servers/tools = %v / %v", q1.MCPServers, q1.MCPTools)
	}
	if q1.MCPCalls != 2 || q1.ToolSig != "apply_patch,github/create_issue" {
		t.Errorf("mcp calls/tool sig = %d / %q", q1.MCPCalls, q1.ToolSig)
	}
	if !reflect.DeepEqual(q1.PolicyFlags, []string{WorkFlagDLP, WorkFlagSecret}) {
		t.Errorf("policy flags = %v", q1.PolicyFlags)
	}
	if q1.Features().Cacheable() {
		t.Error("a request a policy acted on is cacheable")
	}
	if fact := q1.Fact(); fact.Language != "Go" || fact.SessionKind != workintel.SessionInferred || fact.Difficulty != workintel.DifficultyComplex ||
		fact.IsError || fact.MCPCalls != 2 || !fact.PositiveFeedback {
		t.Errorf("fact of q1 = %+v", fact)
	}
	if q2.Classifiable || q2.Text != "" || q2.Team != "unassigned" || q2.UserKey != "missing-key" {
		t.Errorf("q2 = %+v", q2)
	}
	// No key at all, and the secret firewall left an event.
	if !q3.Classifiable || q3.UserKey != "anonymous" || !reflect.DeepEqual(q3.PolicyFlags, []string{WorkFlagSecret}) || q3.Text != "" {
		t.Errorf("q3 = %+v", q3)
	}
	for _, r := range rows {
		if strings.Contains(r.Text, rawOnly) {
			t.Fatalf("%s carries raw prompt content", r.RequestID)
		}
	}

	// The same data by request id, for a later retry.
	again, err := db.WorkIntelRequests(ctx, []string{"q3", "q1", "gone"}, 100)
	if err != nil || len(again) != 2 || again[0].RequestID != "q1" || again[1].RequestID != "q3" {
		t.Fatalf("by id = %+v, %v", again, err)
	}
	if again[0].Text != "가나다라마바사아자차카타파하" || !reflect.DeepEqual(again[0].Languages, q1.Languages) {
		t.Errorf("by id q1 = %+v", again[0])
	}
	if _, _, err := db.WorkIntelBatch(ctx, WorkIntelCursor{}, 10, 100); err == nil {
		t.Fatal("a batch was read without a cursor")
	}
	if count, capped, lag, err := db.WorkIntelBacklog(ctx); err != nil || count != 3 || capped || lag <= 0 || lag > time.Minute {
		t.Fatalf("backlog = %d capped=%v lag=%v, %v", count, capped, lag, err)
	}
}

func TestWorkIntelEndpointClassifiable(t *testing.T) {
	for endpoint, want := range map[string]bool{
		"/v1/chat/completions": true, "/v1/completions": true, "/v1/responses": true, "/v1/messages": true,
		"/v1/embeddings": false, "/v1/models": false, "": false,
	} {
		if got := WorkIntelEndpointClassifiable(endpoint); got != want {
			t.Errorf("%q classifiable = %v, want %v", endpoint, got, want)
		}
	}
}

func TestWorkPolicySeedDraftAndVersions(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if v, err := db.LatestWorkPolicyVersionNumber(ctx); err != nil || v != 0 {
		t.Fatalf("version before first use = %d, %v", v, err)
	}
	// Several instances starting at once seed one draft and one version 1.
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_, errs[i] = db.LatestWorkPolicyVersion(ctx)
			} else {
				_, errs[i] = db.GetWorkPolicyDraft(ctx)
			}
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("concurrent first use: %v", err)
		}
	}
	var drafts, versions int
	_ = db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM work_intel_policy`).Scan(&drafts)
	_ = db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM work_intel_policy_versions`).Scan(&versions)
	if drafts != 1 || versions != 1 {
		t.Fatalf("after seeding: %d drafts, %d versions", drafts, versions)
	}

	latest, err := db.LatestWorkPolicyVersion(ctx)
	if err != nil || latest.Version != 1 || latest.PublishedBy != "system" {
		t.Fatalf("seeded version = %+v, %v", latest, err)
	}
	var seeded workintel.Policy
	if err := json.Unmarshal([]byte(latest.ConfigJSON), &seeded); err != nil {
		t.Fatal(err)
	}
	if _, issues := workintel.Compile(seeded); len(issues) != 0 {
		t.Fatalf("the seeded policy does not compile: %+v", issues[0])
	}
	draft, err := db.GetWorkPolicyDraft(ctx)
	if err != nil || draft.Revision != 1 || draft.ConfigJSON != latest.ConfigJSON {
		t.Fatalf("seeded draft = revision %d, %v", draft.Revision, err)
	}

	// Optimistic save.
	saved, err := db.SaveWorkPolicyDraft(ctx, `{"edit":1}`, 1, "admin_a")
	if err != nil || saved.Revision != 2 || saved.UpdatedBy != "admin_a" {
		t.Fatalf("save = %+v, %v", saved, err)
	}
	if _, err := db.SaveWorkPolicyDraft(ctx, `{"edit":2}`, 1, "admin_b"); !errors.Is(err, ErrWorkPolicyConflict) {
		t.Fatalf("stale save error = %v, want ErrWorkPolicyConflict", err)
	}
	if draft, _ = db.GetWorkPolicyDraft(ctx); draft.ConfigJSON != `{"edit":1}` || draft.Revision != 2 {
		t.Fatalf("draft after a refused save = %+v", draft)
	}

	// Publishing.
	if _, err := db.PublishWorkPolicyChecked(ctx, WorkPolicyPublish{ConfigJSON: `{"v":2}`, Actor: "admin_a", ExpectedDraftRevision: 1}); !errors.Is(err, ErrWorkPolicyConflict) {
		t.Fatalf("publish from a stale review = %v, want ErrWorkPolicyConflict", err)
	}
	v2, err := db.PublishWorkPolicyChecked(ctx, WorkPolicyPublish{ConfigJSON: `{"v":2}`, Note: "첫 배포", Actor: "admin_a", ExpectedDraftRevision: 2})
	if err != nil || v2.Version != 2 || v2.Note != "첫 배포" {
		t.Fatalf("publish = %+v, %v", v2, err)
	}
	if draft, _ = db.GetWorkPolicyDraft(ctx); draft.Revision != 2 {
		t.Fatalf("publishing changed the draft revision to %d", draft.Revision)
	}
	// A rollback publishes an old document and continues editing from it.
	v3, err := db.PublishWorkPolicyChecked(ctx, WorkPolicyPublish{ConfigJSON: latest.ConfigJSON, Note: "롤백", Actor: "admin_b", ReplaceDraft: true})
	if err != nil || v3.Version != 3 {
		t.Fatalf("rollback = %+v, %v", v3, err)
	}
	if draft, _ = db.GetWorkPolicyDraft(ctx); draft.Revision != 3 || draft.ConfigJSON != latest.ConfigJSON || draft.UpdatedBy != "admin_b" {
		t.Fatalf("draft after rollback = revision %d by %s", draft.Revision, draft.UpdatedBy)
	}
	if v4, err := db.PublishWorkPolicy(ctx, `{"v":4}`, "", "admin_a"); err != nil || v4.Version != 4 {
		t.Fatalf("publish = %+v, %v", v4, err)
	}
	if _, err := db.PublishWorkPolicy(ctx, "", "", "admin_a"); err == nil {
		t.Fatal("an empty document was published")
	}

	list, err := db.ListWorkPolicyVersions(ctx, 0)
	if err != nil || len(list) != 4 || list[0].Version != 4 || list[3].Version != 1 || list[2].ConfigJSON != `{"v":2}` {
		t.Fatalf("versions = %+v, %v", list, err)
	}
	if list, _ = db.ListWorkPolicyVersions(ctx, 2); len(list) != 2 || list[1].Version != 3 {
		t.Fatalf("limited versions = %+v", list)
	}
	if got, found, err := db.GetWorkPolicyVersion(ctx, 2); err != nil || !found || got.ConfigJSON != `{"v":2}` || got.PublishedBy != "admin_a" {
		t.Fatalf("version 2 = %+v, %v, %v", got, found, err)
	}
	if _, found, err := db.GetWorkPolicyVersion(ctx, 99); err != nil || found {
		t.Fatalf("version 99 found=%v, %v", found, err)
	}
	if v, _ := db.LatestWorkPolicyVersionNumber(ctx); v != 4 {
		t.Fatalf("latest version number = %d", v)
	}
}

// Concurrent publishers get consecutive version numbers, none twice.
func TestWorkPolicyConcurrentPublishesGetDistinctVersions(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	if _, err := db.LatestWorkPolicyVersion(ctx); err != nil {
		t.Fatal(err)
	}
	const n = 5
	var wg sync.WaitGroup
	versions := make([]int, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v, err := db.PublishWorkPolicy(ctx, fmt.Sprintf(`{"n":%d}`, i), "", "admin")
			versions[i], errs[i] = v.Version, err
		}(i)
	}
	wg.Wait()
	seen := map[int]bool{}
	for i, err := range errs {
		if err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
		if seen[versions[i]] || versions[i] < 2 || versions[i] > n+1 {
			t.Fatalf("versions = %v", versions)
		}
		seen[versions[i]] = true
	}
}

func TestWorkIntelLeaseIsExclusiveAndExpires(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if ok, err := db.AcquireWorkIntelLease(ctx, "worker-a", time.Minute); err != nil || !ok {
		t.Fatalf("first acquire = %v, %v", ok, err)
	}
	if ok, err := db.AcquireWorkIntelLease(ctx, "worker-b", time.Minute); err != nil || ok {
		t.Fatalf("second worker acquired a held lease: %v, %v", ok, err)
	}
	// The holder renews.
	if ok, _ := db.AcquireWorkIntelLease(ctx, "worker-a", time.Minute); !ok {
		t.Fatal("the holder could not renew")
	}
	state, err := db.GetWorkIntelState(ctx)
	if err != nil || state.WorkerToken != "worker-a" || !state.LeaseActive(time.Now()) || state.LeaseActive(time.Now().Add(2*time.Minute)) {
		t.Fatalf("state = %+v, %v", state, err)
	}
	// Only the holder writes statistics.
	if err := db.SaveWorkIntelStats(ctx, "worker-b", `{"by":"b"}`); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveWorkIntelStats(ctx, "worker-a", `{"by":"a"}`); err != nil {
		t.Fatal(err)
	}
	if state, _ = db.GetWorkIntelState(ctx); state.StatsJSON != `{"by":"a"}` {
		t.Fatalf("stats = %s", state.StatsJSON)
	}
	// A release by someone else changes nothing; the holder's frees it.
	if err := db.ReleaseWorkIntelLease(ctx, "worker-b"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := db.AcquireWorkIntelLease(ctx, "worker-b", time.Minute); ok {
		t.Fatal("a foreign release freed the lease")
	}
	if err := db.ReleaseWorkIntelLease(ctx, "worker-a"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := db.AcquireWorkIntelLease(ctx, "worker-b", 40*time.Millisecond); !ok {
		t.Fatal("the lease was not free after its holder released it")
	}
	// An expired lease can be taken over.
	time.Sleep(80 * time.Millisecond)
	if ok, err := db.AcquireWorkIntelLease(ctx, "worker-c", time.Minute); err != nil || !ok {
		t.Fatalf("takeover of an expired lease = %v, %v", ok, err)
	}
	if _, err := db.AcquireWorkIntelLease(ctx, "", time.Minute); err == nil {
		t.Fatal("an empty token was accepted")
	}

	// The first cursor wins, and a periodic mark is kept.
	first, err := db.InitWorkIntelCursor(ctx, workT0)
	if err != nil || first.IngestedAt != workIntelTime(workT0) {
		t.Fatalf("init cursor = %+v, %v", first, err)
	}
	if again, _ := db.InitWorkIntelCursor(ctx, workT0.Add(time.Hour)); again != first {
		t.Fatalf("a second init moved the cursor to %+v", again)
	}
	if err := db.MarkWorkIntelPeriodic(ctx, workT0); err != nil {
		t.Fatal(err)
	}
	if state, _ = db.GetWorkIntelState(ctx); state.PeriodicAt != workIntelTime(workT0) || state.WorkerToken != "worker-c" {
		t.Fatalf("state = %+v", state)
	}
}

func TestWorkClassCacheIsScopedByTeamAndPolicyVersion(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	alpha := WorkClassCacheKey(3, "alpha", "fp1")
	beta := WorkClassCacheKey(3, "beta", "fp1")
	older := WorkClassCacheKey(2, "alpha", "fp1")
	if alpha == beta || alpha == older || len(alpha) != 64 {
		t.Fatalf("cache keys are not scoped: %s %s %s", alpha, beta, older)
	}
	// Where one part ends and the next begins is part of the key.
	if WorkClassCacheKey(1, "a", "b|c") == WorkClassCacheKey(1, "a|b", "c") || WorkClassCacheKey(1, "ab", "c") == WorkClassCacheKey(1, "a", "bc") ||
		WorkClassCacheKey(11, "", "x") == WorkClassCacheKey(1, "1", "x") {
		t.Fatal("different (version, team, fingerprint) triples share a cache key")
	}
	entry := WorkClassCacheEntry{Key: alpha, PolicyVersion: 3, Team: "alpha", CategoryID: "dev.codegen", ActionType: "create", Confidence: 0.8,
		Status: workintel.StatusClassified, Tags: []string{"api"}, Technologies: []string{"Go"}, TargetSystem: "github", WorkTitle: "API 작성", ClassifierModel: "judge"}
	if err := db.PutWorkClassCache(ctx, []WorkClassCacheEntry{entry, {Key: older, PolicyVersion: 2, Team: "alpha", CategoryID: "infra"}, {}}); err != nil {
		t.Fatal(err)
	}
	// The first answer stays the answer.
	changed := entry
	changed.CategoryID = "office"
	if err := db.PutWorkClassCache(ctx, []WorkClassCacheEntry{changed}); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetWorkClassCache(ctx, []string{alpha, beta, older})
	if err != nil || len(got) != 2 {
		t.Fatalf("lookup = %+v, %v", got, err)
	}
	if _, shared := got[beta]; shared {
		t.Fatal("another team's key hit the cache")
	}
	hit := got[alpha]
	if hit.CategoryID != "dev.codegen" || hit.Team != "alpha" || !reflect.DeepEqual(hit.Tags, []string{"api"}) || hit.Hits != 0 || hit.CreatedAt == "" {
		t.Fatalf("entry = %+v", hit)
	}
	result := hit.Result()
	if result.Method != workintel.MethodCache || result.TopCategoryID != "dev" || result.WorkTitle != "API 작성" || result.Confidence != 0.8 {
		t.Fatalf("cached result = %+v", result)
	}
	if err := db.TouchWorkClassCache(ctx, map[string]int{alpha: 3, beta: 5, older: 0}); err != nil {
		t.Fatal(err)
	}
	if got, _ = db.GetWorkClassCache(ctx, []string{alpha}); got[alpha].Hits != 3 {
		t.Fatalf("hits = %d", got[alpha].Hits)
	}
	// Entries of superseded policy versions can never be asked for again.
	if n, err := db.PurgeWorkClassCache(ctx, 3); err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	if got, _ = db.GetWorkClassCache(ctx, []string{alpha, older}); len(got) != 1 {
		t.Fatalf("after purge = %+v", got)
	}
	if got, err = db.GetWorkClassCache(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("empty lookup = %+v, %v", got, err)
	}
}

func TestWorkIntelJobAdmissionIsSingleAndAudited(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	audit := func(id string) AdminAuditLog {
		return AdminAuditLog{ID: id, AdminID: "admin_1", Action: "work_intel.reclassify.requested", AfterValue: `{"total":10}`, CreatedAt: time.Now()}
	}
	job := WorkIntelJob{ID: "job_rev1", Kind: "reclassify", Actor: "admin_1", WorkerToken: "tok-1", ParamsJSON: `{"from":"2026-11-01"}`,
		Progress: WorkIntelJobProgress{Total: 10}}

	if ok, err := db.AdmitWorkIntelJob(ctx, job, audit("audit_1")); err != nil || !ok {
		t.Fatalf("admit = %v, %v", ok, err)
	}
	// The same review confirmed twice starts nothing new and writes no second audit row.
	if ok, err := db.AdmitWorkIntelJob(ctx, job, audit("audit_2")); err != nil || ok {
		t.Fatalf("re-admit = %v, %v", ok, err)
	}
	// A different job while one is running is refused.
	other := job
	other.ID, other.WorkerToken = "job_rev2", "tok-2"
	if ok, err := db.AdmitWorkIntelJob(ctx, other, audit("audit_3")); !errors.Is(err, ErrWorkIntelJobActive) || ok {
		t.Fatalf("second active job = %v, %v; want ErrWorkIntelJobActive", ok, err)
	}
	audits, err := db.ListAdminAudit(ctx, 10)
	if err != nil || len(audits) != 1 || audits[0].ID != "audit_1" {
		t.Fatalf("audit rows = %+v, %v", audits, err)
	}
	if _, err := db.AdmitWorkIntelJob(ctx, WorkIntelJob{ID: "x", Kind: "reclassify"}, audit("audit_4")); err == nil {
		t.Fatal("a job without a worker token was admitted")
	}

	active, found, err := db.ActiveWorkIntelJob(ctx)
	if err != nil || !found || active.ID != "job_rev1" || active.Status != WorkJobRunning || active.Progress.Total != 10 || active.ParamsJSON != `{"from":"2026-11-01"}` {
		t.Fatalf("active = %+v, %v, %v", active, found, err)
	}
	// Progress and heartbeats belong to the worker that owns the job.
	if err := db.UpdateWorkIntelJob(ctx, "job_rev1", "tok-2", &WorkIntelJobProgress{Done: 5}); !errors.Is(err, ErrWorkIntelJobConflict) {
		t.Fatalf("foreign update = %v", err)
	}
	if err := db.UpdateWorkIntelJob(ctx, "job_rev1", "tok-1", &WorkIntelJobProgress{Total: 10, Done: 4, Changed: 2, Cursor: "r4"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateWorkIntelJob(ctx, "job_rev1", "tok-1", nil); err != nil {
		t.Fatal(err)
	}
	got, _, _ := db.GetWorkIntelJob(ctx, "job_rev1")
	if got.Progress.Done != 4 || got.Progress.Cursor != "r4" || got.Actor != "admin_1" {
		t.Fatalf("job = %+v", got)
	}
	if err := db.FinishWorkIntelJob(ctx, "job_rev1", "tok-1", "running", WorkIntelJobProgress{}, ""); err == nil {
		t.Fatal("a non-terminal status finished the job")
	}
	if err := db.FinishWorkIntelJob(ctx, "job_rev1", "tok-2", WorkJobSucceeded, WorkIntelJobProgress{}, ""); !errors.Is(err, ErrWorkIntelJobConflict) {
		t.Fatalf("foreign finish = %v", err)
	}
	if err := db.FinishWorkIntelJob(ctx, "job_rev1", "tok-1", WorkJobSucceeded, WorkIntelJobProgress{Total: 10, Done: 10, Changed: 3, DaysRebuilt: 2}, ""); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = db.GetWorkIntelJob(ctx, "job_rev1"); got.Status != WorkJobSucceeded || got.Progress.Done != 10 || got.FinishedAt == "" {
		t.Fatalf("finished job = %+v", got)
	}
	if err := db.UpdateWorkIntelJob(ctx, "job_rev1", "tok-1", nil); !errors.Is(err, ErrWorkIntelJobConflict) {
		t.Fatalf("heartbeat of a finished job = %v", err)
	}
	if _, found, _ := db.ActiveWorkIntelJob(ctx); found {
		t.Fatal("a finished job is still active")
	}

	// A worker that died: the job reads as interrupted and no longer blocks.
	if ok, err := db.AdmitWorkIntelJob(ctx, other, audit("audit_5")); err != nil || !ok {
		t.Fatalf("admit after the first finished = %v, %v", ok, err)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE work_intel_jobs SET lease_until = ? WHERE id = ?`), workIntelTime(time.Now().Add(-time.Minute)), "job_rev2"); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = db.GetWorkIntelJob(ctx, "job_rev2"); got.Status != WorkJobInterrupted {
		t.Fatalf("abandoned job status = %s", got.Status)
	}
	if err := db.UpdateWorkIntelJob(ctx, "job_rev2", "tok-2", nil); !errors.Is(err, ErrWorkIntelJobConflict) {
		t.Fatalf("heartbeat after the lease expired = %v", err)
	}
	third := job
	third.ID, third.WorkerToken = "job_rev3", "tok-3"
	if ok, err := db.AdmitWorkIntelJob(ctx, third, audit("audit_6")); err != nil || !ok {
		t.Fatalf("admit after an abandoned job = %v, %v", ok, err)
	}
	if err := db.FinishWorkIntelJob(ctx, "job_rev3", "tok-3", WorkJobFailed, WorkIntelJobProgress{Failed: 1}, "provider unavailable"); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = db.GetWorkIntelJob(ctx, "job_rev3"); got.Status != WorkJobFailed || got.Error != "provider unavailable" {
		t.Fatalf("failed job = %+v", got)
	}
	if _, found, err := db.GetWorkIntelJob(ctx, "nope"); err != nil || found {
		t.Fatalf("missing job found=%v, %v", found, err)
	}
}

// Facts go with their request; aggregates stay until their own retention, and
// a day whose facts were purged is never rebuilt into a smaller one.
func TestWorkIntelRetention(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkKeys(t, db)
	start, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().AddDate(0, 0, -100)
	recent := time.Now().UTC().Add(-time.Hour)
	seeds := []workSeed{
		{id: "old1", key: "kA1", session: "Sold", model: "m1", provider: "p1", status: 200, latency: 10, at: old, tokensIn: 1, cost: 1,
			category: "dev", action: "create", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.8},
		{id: "new1", key: "kA1", session: "Snew", model: "m1", provider: "p1", status: 200, latency: 10, at: recent, tokensIn: 1, cost: 1,
			category: "dev", action: "create", method: workintel.MethodRule, state: workintel.StatusClassified, confidence: 0.8},
	}
	for _, s := range seeds {
		seedWorkRequest(t, db, s)
	}
	requests, end, err := db.WorkIntelBatch(ctx, start, 10, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ApplyWorkIntelBatch(ctx, classifyWorkFixture(t, requests, seeds), start, end); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{
		{RequestID: "old1", Reassign: true, CategoryID: "dev", CorrectedBy: "admin"},
		{RequestID: "new1", Reassign: true, CategoryID: "dev", CorrectedBy: "admin"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RebuildWorkIntelDirty(ctx, 10); err != nil {
		t.Fatal(err)
	}
	oldDay, newDay := WorkIntelDay(old), WorkIntelDay(recent)
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := db.db.QueryRowContext(ctx, db.bind(query), args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return n
	}

	// The request retention takes the fact and its correction with the request.
	if n, err := db.PurgeOlderThan(ctx, "request_logs", 30); err != nil || n == 0 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	if facts, _ := db.WorkClassificationsByID(ctx, []string{"old1", "new1"}); len(facts) != 1 || facts[0].RequestID != "new1" {
		t.Fatalf("facts after the request purge = %+v", facts)
	}
	if n := count(`SELECT COUNT(*) FROM work_corrections`); n != 1 {
		t.Fatalf("%d corrections left, want the recent one", n)
	}
	// What was counted stays counted.
	if n := count(`SELECT COUNT(*) FROM work_daily WHERE day = ?`, oldDay); n != 1 {
		t.Fatalf("the aggregate of %s went with its requests", oldDay)
	}
	// And is not recounted from facts that are gone.
	state, _ := db.GetWorkIntelState(ctx)
	if state.FactsPurgedBefore == "" {
		t.Fatal("the facts purge mark was not recorded")
	}
	res, err := db.RebuildWorkDays(ctx, []string{oldDay, newDay})
	if err != nil || !reflect.DeepEqual(res.SkippedDays, []string{oldDay}) || !reflect.DeepEqual(res.Days, []string{newDay}) {
		t.Fatalf("rebuild after purge = %+v, %v", res, err)
	}
	if n := count(`SELECT COALESCE(SUM(requests), 0) FROM work_daily WHERE day = ?`, oldDay); n != 1 {
		t.Fatalf("a purged day was rebuilt to %d requests", n)
	}
	sessions, err := db.RebuildWorkSessions(ctx, []string{"Sold", "Snew"})
	if err != nil || sessions.Sessions != 1 || sessions.SkippedSessions != 1 {
		t.Fatalf("session rebuild after purge = %+v, %v", sessions, err)
	}
	if n := count(`SELECT COUNT(*) FROM work_sessions WHERE session_id = 'Sold' AND requests = 1`); n != 1 {
		t.Fatal("a session whose facts were purged was rebuilt away")
	}
	// The mark only moves forward.
	if _, err := db.PurgeOlderThan(ctx, "request_logs", 60); err != nil {
		t.Fatal(err)
	}
	if after, _ := db.GetWorkIntelState(ctx); after.FactsPurgedBefore != state.FactsPurgedBefore {
		t.Fatalf("the purge mark moved back from %s to %s", state.FactsPurgedBefore, after.FactsPurgedBefore)
	}

	// The aggregates follow their own retention.
	for _, stmt := range []string{
		`INSERT INTO work_insights (id, kind, created_at) VALUES ('i_old', 'k', '` + workIntelTime(old) + `')`,
		`INSERT INTO work_insights (id, kind, created_at) VALUES ('i_new', 'k', '` + workIntelTime(recent) + `')`,
		`INSERT INTO work_automation_candidates (id, computed_at) VALUES ('c_old', '` + workIntelTime(old) + `')`,
		`INSERT INTO work_automation_candidates (id, computed_at) VALUES ('c_new', '` + workIntelTime(recent) + `')`,
	} {
		if _, err := db.db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := db.PurgeWorkIntelOlderThan(ctx, 0); err != nil || n != 0 {
		t.Fatalf("retention 0 deleted %d rows, %v", n, err)
	}
	if n, err := db.PurgeWorkIntelOlderThan(ctx, 400); err != nil || n != 0 {
		t.Fatalf("a 400-day retention deleted %d rows of the last 100 days, %v", n, err)
	}
	if n, err := db.PurgeWorkIntelOlderThan(ctx, 30); err != nil || n == 0 {
		t.Fatalf("purge of the aggregates = %d, %v", n, err)
	}
	for table, where := range map[string]string{
		"work_daily": "day = ?", "work_daily_users": "day = ?", "work_session_segments": "day = ?",
	} {
		if n := count(`SELECT COUNT(*) FROM `+table+` WHERE `+where, oldDay); n != 0 {
			t.Errorf("%s still holds %s", table, oldDay)
		}
		if n := count(`SELECT COUNT(*) FROM `+table+` WHERE `+where, newDay); n == 0 {
			t.Errorf("%s lost %s", table, newDay)
		}
	}
	if got := workDump(t, db, `SELECT session_id FROM work_sessions ORDER BY session_id`); !reflect.DeepEqual(got, []string{"Snew"}) {
		t.Errorf("sessions after retention = %v", got)
	}
	if got := workDump(t, db, `SELECT id FROM work_insights`); !reflect.DeepEqual(got, []string{"i_new"}) {
		t.Errorf("insights after retention = %v", got)
	}
	if got := workDump(t, db, `SELECT id FROM work_automation_candidates`); !reflect.DeepEqual(got, []string{"c_new"}) {
		t.Errorf("candidates after retention = %v", got)
	}
}

// The rebuild buckets confidence in SQL with bounds restated in this package.
// They must be the engine's.
func TestWorkConfidenceBoundsMatchEngine(t *testing.T) {
	bucket := func(c float64) int {
		for i, b := range workConfidenceBounds {
			if c < b {
				return i
			}
		}
		return len(workConfidenceBounds)
	}
	for i := 0; i <= 1000; i++ {
		c := float64(i) / 1000
		if got, want := bucket(c), workintel.ConfidenceBucket(c); got != want {
			t.Fatalf("confidence %.3f: bucket %d here, %d in the engine", c, got, want)
		}
	}
	if len(workintel.ConfidenceLabels) != workConfidenceBuckets || len(workintel.LatencyBounds)+1 != workintel.LatencyBuckets {
		t.Fatal("bucket counts differ from the engine's")
	}
	if got := 8 + len(workDailySumColumns); got != 36 {
		t.Fatalf("work_daily has %d written columns; the dumps in this file assume 36", got)
	}
}
