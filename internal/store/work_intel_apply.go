package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/workintel"
)

// WorkIntelApplyResult reports what one ApplyWorkIntelBatch call wrote.
type WorkIntelApplyResult struct {
	// Inserted is the number of facts written; Existing the number of rows
	// that already had a fact and were left alone.
	Inserted int `json:"inserted"`
	Existing int `json:"existing"`
	// ExistingIDs names the requests that already had a fact. It is empty in
	// normal operation and only filled when a batch is read a second time.
	ExistingIDs []string `json:"existing_ids,omitempty"`
	// Days lists the days whose daily aggregates grew.
	Days []string `json:"days"`
	// Sessions is the number of session heads written.
	Sessions int `json:"sessions"`
}

type workSessionKey struct{ SessionID, Team string }

type workSegmentKey struct{ SessionID, Team, CategoryID, Day string }

// workSessionHead is one row of work_sessions while it is being built. The
// same code builds it from a batch (on top of what is stored) and from the
// facts (from nothing), which is what makes the two agree.
type workSessionHead struct {
	Key                                        workSessionKey
	Kind, UserKey, Client                      string
	Day, FirstAt, LastAt                       string
	Requests, MCPCalls, TokensIn, TokensOut    int64
	LatencyMS, Errors, Retries, ModelSwitches  int64
	CostKRW                                    float64
	Models                                     []string
	LastModel, LastFingerprint, LastIngestedAt string
	LastError, PositiveFeedback                bool
	PolicyFlags                                []string
	Counts                                     map[string]int64
	// outOfOrder is set when a fact arrives that is older than what the head
	// has already seen. The head cannot place it, so the session is rebuilt.
	outOfOrder bool
}

type workSegment struct {
	Key                            workSegmentKey
	TopCategoryID, UserKey, Client string
	FirstAt, LastAt                string
	Requests, TokensIn, TokensOut  int64
	MCPCalls, Errors, LatencyMS    int64
	CostKRW                        float64
}

// observe adds one fact to the head. With decideRetry it also decides whether
// the fact is a retry, which only the head knows: the previous request of the
// session failed and carried the same prompt fingerprint.
func (h *workSessionHead) observe(f *WorkClassification, decideRetry bool) {
	first := h.Requests == 0
	inOrder := first || f.IngestedAt >= h.LastIngestedAt
	if decideRetry {
		f.IsRetry = !first && inOrder && h.LastError && f.Fingerprint != "" && f.Fingerprint == h.LastFingerprint
	}
	if first {
		h.Kind, h.UserKey, h.Client = f.SessionKind, f.UserKey, f.Client
		h.FirstAt, h.LastAt = f.CreatedAt, f.CreatedAt
	} else {
		// Requests are ingested when they finish, so a long request can be
		// ingested after one that started later: the span is a min and a max.
		if f.CreatedAt < h.FirstAt {
			h.FirstAt = f.CreatedAt
		}
		if f.CreatedAt > h.LastAt {
			h.LastAt = f.CreatedAt
		}
	}
	h.Day = workIntelDayOf(h.FirstAt)
	if inOrder {
		if h.LastModel != "" && f.Model != "" && f.Model != h.LastModel {
			h.ModelSwitches++
		}
		if f.Model != "" {
			h.LastModel = f.Model
		}
		h.LastFingerprint, h.LastError, h.LastIngestedAt = f.Fingerprint, f.IsError, f.IngestedAt
	} else {
		h.outOfOrder = true
	}
	h.Requests++
	h.MCPCalls += f.MCPCalls
	h.TokensIn += f.TokensIn
	h.TokensOut += f.TokensOut
	h.CostKRW += f.CostKRW
	h.LatencyMS += f.LatencyMS
	if f.IsError {
		h.Errors++
	}
	if f.IsRetry {
		h.Retries++
	}
	if f.Model != "" && len(h.Models) < workSessionMaxModels && !workContains(h.Models, f.Model) {
		h.Models = append(h.Models, f.Model)
	}
	for _, flag := range f.PolicyFlags {
		h.PolicyFlags = workAddFlag(h.PolicyFlags, flag)
	}
	if f.PositiveFeedback {
		h.PositiveFeedback = true
	}
	if h.Counts == nil {
		h.Counts = map[string]int64{}
	}
	if _, known := h.Counts[f.CategoryID]; known || len(h.Counts) < workSessionMaxCategories {
		h.Counts[f.CategoryID]++
	}
}

// completion derives the session state. Feedback is the only evidence that
// work was finished; a failed last request is evidence that it was not.
func (h *workSessionHead) completion() string {
	switch {
	case h.PositiveFeedback:
		return WorkCompletionConfirmed
	case h.LastError:
		return WorkCompletionError
	}
	return WorkCompletionUnknown
}

// primary returns the category most of the session's requests fell into. Ties
// go to the smaller id so the answer does not depend on map order.
func (h *workSessionHead) primary() string {
	best, bestN := "", int64(0)
	for id, n := range h.Counts {
		if n > bestN || (n == bestN && id < best) {
			best, bestN = id, n
		}
	}
	return best
}

func (seg *workSegment) observe(f *WorkClassification) {
	if seg.Requests == 0 {
		seg.TopCategoryID, seg.UserKey, seg.Client = f.TopCategoryID, f.UserKey, f.Client
		seg.FirstAt, seg.LastAt = f.CreatedAt, f.CreatedAt
	} else {
		if f.CreatedAt < seg.FirstAt {
			seg.FirstAt = f.CreatedAt
		}
		if f.CreatedAt > seg.LastAt {
			seg.LastAt = f.CreatedAt
		}
	}
	seg.Requests++
	seg.TokensIn += f.TokensIn
	seg.TokensOut += f.TokensOut
	seg.CostKRW += f.CostKRW
	seg.MCPCalls += f.MCPCalls
	seg.LatencyMS += f.LatencyMS
	if f.IsError {
		seg.Errors++
	}
}

func workContains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// workSessionBuilder collects heads and segments for a set of facts.
type workSessionBuilder struct {
	heads    map[workSessionKey]*workSessionHead
	segments map[workSegmentKey]*workSegment
	touched  map[workSessionKey]bool
}

func newWorkSessionBuilder(existing map[workSessionKey]*workSessionHead) *workSessionBuilder {
	if existing == nil {
		existing = map[workSessionKey]*workSessionHead{}
	}
	return &workSessionBuilder{heads: existing, segments: map[workSegmentKey]*workSegment{}, touched: map[workSessionKey]bool{}}
}

func (b *workSessionBuilder) add(f *WorkClassification, decideRetry bool) {
	// A request without a session id belongs to no session; folding them all
	// into one would invent a session nobody had.
	if f.SessionID == "" {
		if decideRetry {
			f.IsRetry = false
		}
		return
	}
	key := workSessionKey{f.SessionID, f.Team}
	head := b.heads[key]
	if head == nil {
		head = &workSessionHead{Key: key}
		b.heads[key] = head
	}
	head.observe(f, decideRetry)
	b.touched[key] = true

	segKey := workSegmentKey{f.SessionID, f.Team, f.CategoryID, f.Day}
	seg := b.segments[segKey]
	if seg == nil {
		seg = &workSegment{Key: segKey}
		b.segments[segKey] = seg
	}
	seg.observe(f)
}

const workSessionHeadColumns = `session_id, team, session_kind, user_key, client, day, first_at, last_at, requests, mcp_calls,
	tokens_in, tokens_out, cost_krw, latency_ms, errors, retries, models, model_switches, last_model, last_fingerprint,
	last_error, last_ingested_at, policy_flags, positive_feedback, completion, category_counts, primary_category_id,
	primary_top_category_id, updated_at`

const workSessionHeadColumnCount = 29

// workSessionHeadUpdate overwrites every non-key column: the head written is
// the complete new state, computed under the writer lock from the stored one.
var workSessionHeadUpdate = func() string {
	cols := []string{"session_kind", "user_key", "client", "day", "first_at", "last_at", "requests", "mcp_calls",
		"tokens_in", "tokens_out", "cost_krw", "latency_ms", "errors", "retries", "models", "model_switches", "last_model",
		"last_fingerprint", "last_error", "last_ingested_at", "policy_flags", "positive_feedback", "completion",
		"category_counts", "primary_category_id", "primary_top_category_id", "updated_at"}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = c + " = excluded." + c
	}
	return "ON CONFLICT(session_id, team) DO UPDATE SET " + strings.Join(sets, ", ")
}()

func (s *SQLStore) loadWorkSessionHeads(ctx context.Context, q workQuerier, sessionIDs []string) (map[workSessionKey]*workSessionHead, error) {
	out := map[workSessionKey]*workSessionHead{}
	for _, chunk := range workChunks(sessionIDs, WorkIntelMaxBatch) {
		rows, err := q.QueryContext(ctx, s.bind(`SELECT session_id, team, session_kind, user_key, client, day, first_at, last_at,
				requests, mcp_calls, tokens_in, tokens_out, cost_krw, latency_ms, errors, retries, models, model_switches,
				last_model, last_fingerprint, last_error, last_ingested_at, policy_flags, positive_feedback, category_counts
			FROM work_sessions WHERE session_id IN (`+placeholders(len(chunk))+`)`), workAnyArgs(chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			h := &workSessionHead{}
			var models, flags, counts string
			var lastError, feedback int
			if err := rows.Scan(&h.Key.SessionID, &h.Key.Team, &h.Kind, &h.UserKey, &h.Client, &h.Day, &h.FirstAt, &h.LastAt,
				&h.Requests, &h.MCPCalls, &h.TokensIn, &h.TokensOut, &h.CostKRW, &h.LatencyMS, &h.Errors, &h.Retries, &models, &h.ModelSwitches,
				&h.LastModel, &h.LastFingerprint, &lastError, &h.LastIngestedAt, &flags, &feedback, &counts); err != nil {
				rows.Close()
				return nil, err
			}
			h.Models, h.PolicyFlags, h.Counts = decodeList(models), workSplitFlags(flags), workDecodeCounts(counts)
			h.LastError, h.PositiveFeedback = lastError != 0, feedback != 0
			out[h.Key] = h
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *SQLStore) writeWorkSessionHeads(ctx context.Context, q workQuerier, heads []*workSessionHead, now string) error {
	args := make([]any, 0, len(heads)*workSessionHeadColumnCount)
	for _, h := range heads {
		counts, err := json.Marshal(h.Counts)
		if err != nil {
			return err
		}
		primary := h.primary()
		args = append(args, h.Key.SessionID, h.Key.Team, h.Kind, h.UserKey, h.Client, h.Day, h.FirstAt, h.LastAt, h.Requests, h.MCPCalls,
			h.TokensIn, h.TokensOut, h.CostKRW, h.LatencyMS, h.Errors, h.Retries, workEncodeList(h.Models), h.ModelSwitches, h.LastModel, h.LastFingerprint,
			boolInt(h.LastError), h.LastIngestedAt, workJoinFlags(h.PolicyFlags), boolInt(h.PositiveFeedback), h.completion(), string(counts), primary,
			workTopCategory(primary), now)
	}
	_, err := s.workBatchExec(ctx, q, `INSERT INTO work_sessions (`+workSessionHeadColumns+`)`,
		workRowPlaceholder(workSessionHeadColumnCount), workSessionHeadUpdate, workSessionHeadColumnCount, args)
	return err
}

// workSegmentUpsert adds a segment delta to the stored segment. The stored
// user and client are kept: they describe the segment's first request.
const workSegmentUpsert = `ON CONFLICT(session_id, team, category_id, day) DO UPDATE SET
	first_at = CASE WHEN excluded.first_at < work_session_segments.first_at THEN excluded.first_at ELSE work_session_segments.first_at END,
	last_at = CASE WHEN excluded.last_at > work_session_segments.last_at THEN excluded.last_at ELSE work_session_segments.last_at END,
	requests = work_session_segments.requests + excluded.requests,
	tokens_in = work_session_segments.tokens_in + excluded.tokens_in,
	tokens_out = work_session_segments.tokens_out + excluded.tokens_out,
	cost_krw = work_session_segments.cost_krw + excluded.cost_krw,
	mcp_calls = work_session_segments.mcp_calls + excluded.mcp_calls,
	errors = work_session_segments.errors + excluded.errors,
	latency_ms = work_session_segments.latency_ms + excluded.latency_ms`

const workSegmentColumnCount = 16

func (s *SQLStore) writeWorkSegments(ctx context.Context, q workQuerier, segments []*workSegment) error {
	args := make([]any, 0, len(segments)*workSegmentColumnCount)
	for _, seg := range segments {
		args = append(args, seg.Key.SessionID, seg.Key.Team, seg.Key.CategoryID, seg.Key.Day, seg.TopCategoryID, seg.UserKey, seg.Client,
			seg.FirstAt, seg.LastAt, seg.Requests, seg.TokensIn, seg.TokensOut, seg.CostKRW, seg.MCPCalls, seg.Errors, seg.LatencyMS)
	}
	_, err := s.workBatchExec(ctx, q, `INSERT INTO work_session_segments (session_id, team, category_id, day, top_category_id, user_key, client,
		first_at, last_at, requests, tokens_in, tokens_out, cost_krw, mcp_calls, errors, latency_ms)`,
		workRowPlaceholder(workSegmentColumnCount), workSegmentUpsert, workSegmentColumnCount, args)
	return err
}

type workDailyKey struct{ Day, CategoryID, ActionType, Team, Model, Provider, Client string }

type workDailyDelta struct {
	TopCategoryID                 string
	Requests, TokensIn, TokensOut int64
	MCPCalls, Errors, Retries     int64
	LatencyMS                     int64
	CostKRW                       float64
	Lat                           [workintel.LatencyBuckets]int64
	Method                        [len(workDailyMethods)]int64
	Status                        [len(workDailyStatuses)]int64
	Conf                          [workConfidenceBuckets]int64
}

// The method and status counters of work_daily, in column order. "classified"
// has no column: it is the requests that are in none of the others.
var (
	workDailyMethods  = [4]string{workintel.MethodRule, workintel.MethodLLM, workintel.MethodCache, workintel.MethodManual}
	workDailyStatuses = [3]string{workintel.StatusReview, workintel.StatusUnclassified, workintel.StatusFailed}
)

// workConfidenceBounds are the upper bounds of the first four confidence
// buckets. They restate workintel.ConfidenceBucket so the rebuild can bucket
// in SQL; TestWorkConfidenceBoundsMatchEngine keeps the two the same.
var workConfidenceBounds = [4]float64{0.5, 0.6, 0.75, 0.9}

const workConfidenceBuckets = 5

// workDailySumColumns are the additive columns of work_daily in the order the
// delta is written.
var workDailySumColumns = func() []string {
	cols := []string{"requests", "tokens_in", "tokens_out", "cost_krw", "mcp_calls", "errors", "retries", "latency_ms"}
	for i := 0; i < workintel.LatencyBuckets; i++ {
		cols = append(cols, fmt.Sprintf("lat_b%d", i))
	}
	cols = append(cols, "m_rule", "m_llm", "m_cache", "m_manual", "s_review", "s_unclassified", "s_failed")
	for i := 0; i < workConfidenceBuckets; i++ {
		cols = append(cols, fmt.Sprintf("conf_b%d", i))
	}
	return cols
}()

const workDailyKeyColumns = "day, category_id, action_type, team, model, provider, client"

var workDailyInsertHeader = "INSERT INTO work_daily (" + workDailyKeyColumns + ", top_category_id, " + strings.Join(workDailySumColumns, ", ") + ")"

var workDailyUpsert = func() string {
	sets := []string{"top_category_id = excluded.top_category_id"}
	for _, c := range workDailySumColumns {
		sets = append(sets, c+" = work_daily."+c+" + excluded."+c)
	}
	return "ON CONFLICT(" + workDailyKeyColumns + ") DO UPDATE SET " + strings.Join(sets, ", ")
}()

func (d *workDailyDelta) observe(f *WorkClassification) {
	d.TopCategoryID = f.TopCategoryID
	d.Requests++
	d.TokensIn += f.TokensIn
	d.TokensOut += f.TokensOut
	d.CostKRW += f.CostKRW
	d.MCPCalls += f.MCPCalls
	d.LatencyMS += f.LatencyMS
	if f.IsError {
		d.Errors++
	}
	if f.IsRetry {
		d.Retries++
	}
	d.Lat[workintel.LatencyBucket(f.LatencyMS)]++
	for i, m := range workDailyMethods {
		if f.Method == m {
			d.Method[i]++
		}
	}
	for i, st := range workDailyStatuses {
		if f.Status == st {
			d.Status[i]++
		}
	}
	d.Conf[workintel.ConfidenceBucket(f.Confidence)]++
}

func (d *workDailyDelta) args(key workDailyKey) []any {
	args := []any{key.Day, key.CategoryID, key.ActionType, key.Team, key.Model, key.Provider, key.Client, d.TopCategoryID,
		d.Requests, d.TokensIn, d.TokensOut, d.CostKRW, d.MCPCalls, d.Errors, d.Retries, d.LatencyMS}
	for _, v := range d.Lat {
		args = append(args, v)
	}
	for _, v := range d.Method {
		args = append(args, v)
	}
	for _, v := range d.Status {
		args = append(args, v)
	}
	for _, v := range d.Conf {
		args = append(args, v)
	}
	return args
}

// ApplyWorkIntelBatch stores the classification of one batch and moves the
// cursor from prev to next, in one transaction:
//
//   - the cursor is advanced only if it still equals prev (otherwise
//     ErrWorkIntelCursorMoved and nothing is written), which also takes the
//     writer lock;
//   - facts are inserted for the requests that have none;
//   - for exactly those facts, the daily aggregates, the daily user sets, the
//     session heads and the session segments are updated.
//
// Rows must describe requests in (ingested_at, request_id) order; they are
// sorted here as well. IsRetry is decided here and written back into rows.
// Applying a batch whose facts already exist only moves the cursor.
func (s *SQLStore) ApplyWorkIntelBatch(ctx context.Context, rows []WorkClassification, prev, next WorkIntelCursor) (WorkIntelApplyResult, error) {
	result := WorkIntelApplyResult{Days: []string{}}
	if prev.After(next) {
		return result, errors.New("work intel cursor cannot move backwards")
	}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()

	now := workIntelTime(time.Now())
	res, err := tx.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET cursor_ingested_at = ?, cursor_id = ?, updated_at = ?
		WHERE id = ? AND cursor_ingested_at = ? AND cursor_id = ?`),
		next.IngestedAt, next.RequestID, now, workIntelStateID, prev.IngestedAt, prev.RequestID)
	if err != nil {
		return result, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return result, err
	} else if n != 1 {
		return result, ErrWorkIntelCursorMoved
	}

	// One fact per request, in the order the requests were ingested.
	order := make([]*WorkClassification, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for i := range rows {
		if rows[i].RequestID == "" || seen[rows[i].RequestID] {
			continue
		}
		seen[rows[i].RequestID] = true
		rows[i].normalize(now)
		order = append(order, &rows[i])
	}
	sort.SliceStable(order, func(i, j int) bool {
		if order[i].IngestedAt != order[j].IngestedAt {
			return order[i].IngestedAt < order[j].IngestedAt
		}
		return order[i].RequestID < order[j].RequestID
	})
	ids := make([]string, len(order))
	for i, f := range order {
		ids[i] = f.RequestID
	}
	existing, err := s.existingWorkFactIDs(ctx, tx, ids)
	if err != nil {
		return result, err
	}
	fresh := make([]*WorkClassification, 0, len(order))
	for _, f := range order {
		if existing[f.RequestID] {
			result.Existing++
			result.ExistingIDs = append(result.ExistingIDs, f.RequestID)
			continue
		}
		fresh = append(fresh, f)
	}
	if len(fresh) == 0 {
		return result, tx.Commit()
	}

	sessionIDs := []string{}
	seenSession := map[string]bool{}
	for _, f := range fresh {
		if f.SessionID != "" && !seenSession[f.SessionID] {
			seenSession[f.SessionID] = true
			sessionIDs = append(sessionIDs, f.SessionID)
		}
	}
	heads, err := s.loadWorkSessionHeads(ctx, tx, sessionIDs)
	if err != nil {
		return result, err
	}
	builder := newWorkSessionBuilder(heads)
	daily := map[workDailyKey]*workDailyDelta{}
	dailyOrder := []workDailyKey{}
	type userKey struct{ Day, CategoryID, Team, UserKey string }
	users := map[userKey]string{}
	userOrder := []userKey{}
	days := map[string]bool{}
	for _, f := range fresh {
		// The session comes first: it decides IsRetry, which the daily
		// aggregate counts.
		builder.add(f, true)
		key := workDailyKey{f.Day, f.CategoryID, f.ActionType, f.Team, f.Model, f.Provider, f.Client}
		delta := daily[key]
		if delta == nil {
			delta = &workDailyDelta{}
			daily[key] = delta
			dailyOrder = append(dailyOrder, key)
		}
		delta.observe(f)
		uk := userKey{f.Day, f.CategoryID, f.Team, f.UserKey}
		if _, ok := users[uk]; !ok {
			users[uk] = f.TopCategoryID
			userOrder = append(userOrder, uk)
		}
		days[f.Day] = true
	}

	factArgs := make([]any, 0, len(fresh)*workFactColumnCount)
	for _, f := range fresh {
		factArgs = append(factArgs, workFactArgs(f)...)
	}
	written, err := s.workBatchExec(ctx, tx, `INSERT INTO work_classifications (`+workFactColumns+`)`,
		workRowPlaceholder(workFactColumnCount), `ON CONFLICT(request_id) DO NOTHING`, workFactColumnCount, factArgs)
	if err != nil {
		return result, err
	}
	// The aggregates below were computed for every fresh row. If the database
	// skipped one, writing them would count a request twice, so the whole
	// batch is abandoned and read again.
	if written != int64(len(fresh)) {
		return result, fmt.Errorf("work intel batch: %d of %d facts were written", written, len(fresh))
	}

	dailyArgs := make([]any, 0, len(dailyOrder)*(8+len(workDailySumColumns)))
	for _, key := range dailyOrder {
		dailyArgs = append(dailyArgs, daily[key].args(key)...)
	}
	perDaily := 8 + len(workDailySumColumns)
	if _, err := s.workBatchExec(ctx, tx, workDailyInsertHeader, workRowPlaceholder(perDaily), workDailyUpsert, perDaily, dailyArgs); err != nil {
		return result, err
	}

	userArgs := make([]any, 0, len(userOrder)*5)
	for _, uk := range userOrder {
		userArgs = append(userArgs, uk.Day, uk.CategoryID, uk.Team, uk.UserKey, users[uk])
	}
	if _, err := s.workBatchExec(ctx, tx, `INSERT INTO work_daily_users (day, category_id, team, user_key, top_category_id)`,
		workRowPlaceholder(5), `ON CONFLICT(day, category_id, team, user_key) DO NOTHING`, 5, userArgs); err != nil {
		return result, err
	}

	touched := make([]*workSessionHead, 0, len(builder.touched))
	dirty := []string{}
	for key := range builder.touched {
		head := builder.heads[key]
		touched = append(touched, head)
		if head.outOfOrder {
			dirty = append(dirty, key.SessionID)
		}
	}
	sort.Slice(touched, func(i, j int) bool {
		if touched[i].Key.SessionID != touched[j].Key.SessionID {
			return touched[i].Key.SessionID < touched[j].Key.SessionID
		}
		return touched[i].Key.Team < touched[j].Key.Team
	})
	if err := s.writeWorkSessionHeads(ctx, tx, touched, now); err != nil {
		return result, err
	}
	segments := make([]*workSegment, 0, len(builder.segments))
	for _, seg := range builder.segments {
		segments = append(segments, seg)
	}
	sort.Slice(segments, func(i, j int) bool { return workSegmentLess(segments[i].Key, segments[j].Key) })
	if err := s.writeWorkSegments(ctx, tx, segments); err != nil {
		return result, err
	}
	if err := s.markWorkIntelDirty(ctx, tx, workIntelDirtySession, dirty, now); err != nil {
		return result, err
	}

	if err := tx.Commit(); err != nil {
		return result, err
	}
	result.Inserted = len(fresh)
	result.Sessions = len(touched)
	for day := range days {
		result.Days = append(result.Days, day)
	}
	sort.Strings(result.Days)
	return result, nil
}

func workSegmentLess(a, b workSegmentKey) bool {
	if a.SessionID != b.SessionID {
		return a.SessionID < b.SessionID
	}
	if a.Team != b.Team {
		return a.Team < b.Team
	}
	if a.CategoryID != b.CategoryID {
		return a.CategoryID < b.CategoryID
	}
	return a.Day < b.Day
}

func (s *SQLStore) existingWorkFactIDs(ctx context.Context, q workQuerier, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, chunk := range workChunks(ids, WorkIntelMaxBatch) {
		rows, err := q.QueryContext(ctx, s.bind(`SELECT request_id FROM work_classifications
			WHERE request_id IN (`+placeholders(len(chunk))+`)`), workAnyArgs(chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			out[id] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// markWorkIntelDirty records days or sessions whose aggregates no longer
// match their facts. It runs in the transaction that made them stale.
func (s *SQLStore) markWorkIntelDirty(ctx context.Context, q workQuerier, kind string, refs []string, now string) error {
	args := make([]any, 0, len(refs)*3)
	seen := map[string]bool{}
	for _, ref := range refs {
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true
		args = append(args, kind, ref, now)
	}
	_, err := s.workBatchExec(ctx, q, `INSERT INTO work_intel_dirty (kind, ref, marked_at)`, workRowPlaceholder(3),
		`ON CONFLICT(kind, ref) DO NOTHING`, 3, args)
	return err
}

// SyncWorkSessionFeedback confirms the sessions that received positive
// feedback since the given time. Feedback usually arrives long after a
// request was classified, so the batch that classified it could not see it.
// It returns the number of sessions newly confirmed.
func (s *SQLStore) SyncWorkSessionFeedback(ctx context.Context, since time.Time) (int64, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT DISTINCT c.session_id, c.team
		FROM llm_feedback f
		JOIN work_classifications c ON c.request_id = f.request_id
		WHERE f.created_at >= ? AND f.rating > 0 AND c.session_id <> ''`), formatTime(since))
	if err != nil {
		return 0, err
	}
	keys := []workSessionKey{}
	for rows.Next() {
		var key workSessionKey
		if err := rows.Scan(&key.SessionID, &key.Team); err != nil {
			rows.Close()
			return 0, err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(keys) == 0 {
		return 0, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := s.lockWorkIntelTx(ctx, tx); err != nil {
		return 0, err
	}
	now := workIntelTime(time.Now())
	var confirmed int64
	for _, key := range keys {
		res, err := tx.ExecContext(ctx, s.bind(`UPDATE work_sessions SET positive_feedback = 1, completion = ?, updated_at = ?
			WHERE session_id = ? AND team = ? AND positive_feedback = 0`),
			WorkCompletionConfirmed, now, key.SessionID, key.Team)
		if err != nil {
			return 0, err
		}
		if n, err := res.RowsAffected(); err == nil {
			confirmed += n
		}
	}
	return confirmed, tx.Commit()
}
