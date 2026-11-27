package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/workintel"
)

// WorkClassificationChange is one update of an existing fact: a new
// classification (Reassign), or only the bookkeeping of the semantic step.
type WorkClassificationChange struct {
	RequestID string
	// Reassign replaces the classification with the fields below. When false
	// only NeedsLLM and AddLLMAttempts are written.
	Reassign        bool
	CategoryID      string
	TopCategoryID   string
	ActionType      string
	Confidence      float64
	Method          string
	ClassifierModel string
	PolicyVersion   int
	Status          string
	Tags            []string
	Technologies    []string
	TargetSystem    string
	WorkTitle       string
	NewCategoryHint string

	// NeedsLLM is the new value of the flag; AddLLMAttempts is added to the
	// attempt counter (a failed retry passes 1).
	NeedsLLM       bool
	AddLLMAttempts int

	// CorrectedBy marks an administrator correction. The store then records
	// who and when on the fact, forces method "manual", confidence 1 and
	// status "classified", and writes a work_corrections row with the
	// classification that was replaced, in the same transaction. An empty
	// ActionType keeps the fact's action. Reason is stored on that row.
	CorrectedBy string
	Reason      string

	// KeepManual leaves a fact an administrator corrected untouched; a
	// reclassification must not undo their work.
	KeepManual bool
}

// SetResult fills the change from a classification result and marks it as a
// reassignment. The caller is responsible for having redacted the title, tags
// and hint.
func (c *WorkClassificationChange) SetResult(res workintel.Result, policyVersion int, classifierModel string) {
	c.Reassign = true
	c.CategoryID, c.TopCategoryID = res.CategoryID, res.TopCategoryID
	c.ActionType = res.ActionType
	c.Confidence = res.Confidence
	c.Method = res.Method
	c.Status = res.Status
	c.Tags, c.Technologies = res.Tags, res.Technologies
	c.TargetSystem, c.WorkTitle, c.NewCategoryHint = res.TargetSystem, res.WorkTitle, res.NewCategoryHint
	c.PolicyVersion, c.ClassifierModel = policyVersion, classifierModel
	c.NeedsLLM = res.NeedsLLM
}

// WorkReassignResult reports what UpdateWorkClassifications changed.
type WorkReassignResult struct {
	// Updated counts the facts written; Reassigned those whose classification
	// was replaced.
	Updated    int `json:"updated"`
	Reassigned int `json:"reassigned"`
	// SkippedManual counts facts left alone because of KeepManual; Missing the
	// requests that have no fact.
	SkippedManual int `json:"skipped_manual"`
	Missing       int `json:"missing"`
	// Days and SessionIDs are the aggregates that no longer match the facts.
	// They are already recorded in work_intel_dirty; pass them to
	// RebuildWorkDays and RebuildWorkSessions (or let the worker drain the
	// marks with RebuildWorkIntelDirty).
	Days       []string `json:"days"`
	SessionIDs []string `json:"session_ids"`
}

// WorkCorrection is one row of work_corrections.
type WorkCorrection struct {
	ID             string  `json:"id"`
	RequestID      string  `json:"request_id"`
	FromCategoryID string  `json:"from_category_id"`
	ToCategoryID   string  `json:"to_category_id"`
	FromAction     string  `json:"from_action"`
	ToAction       string  `json:"to_action"`
	FromMethod     string  `json:"from_method"`
	FromConfidence float64 `json:"from_confidence"`
	PolicyVersion  int     `json:"policy_version"`
	Actor          string  `json:"actor"`
	Reason         string  `json:"reason"`
	CreatedAt      string  `json:"created_at"`
}

// WorkRebuildResult reports what a rebuild regenerated.
type WorkRebuildResult struct {
	// Days were regenerated from facts. SkippedDays begin before the facts
	// purge mark: some of their facts are gone, so their aggregates are kept
	// as they are rather than replaced by a partial recount.
	Days        []string `json:"days"`
	SkippedDays []string `json:"skipped_days"`
	// Sessions is the number of session ids regenerated; SkippedSessions those
	// kept for the same reason.
	Sessions        int `json:"sessions"`
	SkippedSessions int `json:"skipped_sessions"`
}

// UpdateWorkClassifications applies reassignments to existing facts in one
// transaction. It does not touch the aggregates: it records the days and
// sessions that became stale in work_intel_dirty (same transaction) and
// returns them, and the rebuild regenerates them from the facts. That keeps
// one way of computing the aggregates of changed data, so they cannot drift.
func (s *SQLStore) UpdateWorkClassifications(ctx context.Context, changes []WorkClassificationChange) (WorkReassignResult, error) {
	result := WorkReassignResult{Days: []string{}, SessionIDs: []string{}}
	if len(changes) == 0 {
		return result, nil
	}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := s.lockWorkIntelTx(ctx, tx); err != nil {
		return result, err
	}

	ids := make([]string, 0, len(changes))
	for _, ch := range changes {
		ids = append(ids, ch.RequestID)
	}
	facts, err := s.workFactsByID(ctx, tx, ids)
	if err != nil {
		return result, err
	}
	current := make(map[string]*WorkClassification, len(facts))
	for i := range facts {
		current[facts[i].RequestID] = &facts[i]
	}

	now := workIntelTime(time.Now())
	days, sessions := map[string]bool{}, map[string]bool{}
	corrections := []WorkCorrection{}
	for _, ch := range changes {
		fact := current[ch.RequestID]
		if fact == nil {
			result.Missing++
			continue
		}
		if !ch.Reassign {
			if _, err := tx.ExecContext(ctx, s.bind(`UPDATE work_classifications SET needs_llm = ?, llm_attempts = llm_attempts + ?, updated_at = ?
				WHERE request_id = ?`), boolInt(ch.NeedsLLM), ch.AddLLMAttempts, now, ch.RequestID); err != nil {
				return result, err
			}
			fact.NeedsLLM, fact.LLMAttempts = ch.NeedsLLM, fact.LLMAttempts+ch.AddLLMAttempts
			result.Updated++
			continue
		}
		if ch.KeepManual && fact.Method == workintel.MethodManual {
			result.SkippedManual++
			continue
		}

		next := *fact
		next.CategoryID = ch.CategoryID
		if next.CategoryID == "" {
			next.CategoryID = workintel.OtherCategoryID
		}
		next.TopCategoryID = ch.TopCategoryID
		if next.TopCategoryID == "" {
			next.TopCategoryID = workTopCategory(next.CategoryID)
		}
		if ch.ActionType != "" {
			next.ActionType = ch.ActionType
		}
		next.Confidence, next.Method, next.Status = ch.Confidence, ch.Method, ch.Status
		next.ClassifierModel, next.PolicyVersion = ch.ClassifierModel, ch.PolicyVersion
		next.Tags, next.Technologies = ch.Tags, ch.Technologies
		next.TargetSystem, next.WorkTitle, next.NewCategoryHint = ch.TargetSystem, ch.WorkTitle, ch.NewCategoryHint
		next.NeedsLLM = ch.NeedsLLM
		next.LLMAttempts = fact.LLMAttempts + ch.AddLLMAttempts
		if ch.CorrectedBy != "" {
			next.Method, next.Confidence, next.Status = workintel.MethodManual, 1, workintel.StatusClassified
			next.NeedsLLM = false
			next.CorrectedBy, next.CorrectedAt = ch.CorrectedBy, now
			corrections = append(corrections, WorkCorrection{
				RequestID: fact.RequestID, FromCategoryID: fact.CategoryID, ToCategoryID: next.CategoryID,
				FromAction: fact.ActionType, ToAction: next.ActionType, FromMethod: fact.Method, FromConfidence: fact.Confidence,
				PolicyVersion: fact.PolicyVersion, Actor: ch.CorrectedBy, Reason: ch.Reason, CreatedAt: now,
			})
		}
		if next.Method == "" {
			next.Method = workintel.MethodRule
		}
		if next.Status == "" {
			next.Status = workintel.StatusClassified
		}

		if _, err := tx.ExecContext(ctx, s.bind(`UPDATE work_classifications SET category_id = ?, top_category_id = ?, action_type = ?,
				confidence = ?, method = ?, classifier_model = ?, policy_version = ?, status = ?, tags = ?, technologies = ?,
				target_system = ?, work_title = ?, new_category_hint = ?, needs_llm = ?, llm_attempts = ?, corrected_by = ?,
				corrected_at = ?, updated_at = ?
			WHERE request_id = ?`), cleanArgs([]any{next.CategoryID, next.TopCategoryID, next.ActionType,
			next.Confidence, next.Method, next.ClassifierModel, next.PolicyVersion, next.Status, workEncodeList(next.Tags), workEncodeList(next.Technologies),
			next.TargetSystem, next.WorkTitle, next.NewCategoryHint, boolInt(next.NeedsLLM), next.LLMAttempts, next.CorrectedBy,
			next.CorrectedAt, now, next.RequestID})...); err != nil {
			return result, err
		}
		result.Updated++
		result.Reassigned++
		// Only what an aggregate actually counts makes it stale: a new title or
		// tag does not.
		if next.CategoryID != fact.CategoryID || next.ActionType != fact.ActionType || next.Method != fact.Method ||
			next.Status != fact.Status || workintel.ConfidenceBucket(next.Confidence) != workintel.ConfidenceBucket(fact.Confidence) {
			days[fact.Day] = true
		}
		if next.CategoryID != fact.CategoryID && fact.SessionID != "" {
			sessions[fact.SessionID] = true
		}
		*fact = next
	}

	if err := s.insertWorkCorrections(ctx, tx, corrections); err != nil {
		return result, err
	}
	for day := range days {
		result.Days = append(result.Days, day)
	}
	for id := range sessions {
		result.SessionIDs = append(result.SessionIDs, id)
	}
	sort.Strings(result.Days)
	sort.Strings(result.SessionIDs)
	if err := s.markWorkIntelDirty(ctx, tx, workIntelDirtyDay, result.Days, now); err != nil {
		return result, err
	}
	if err := s.markWorkIntelDirty(ctx, tx, workIntelDirtySession, result.SessionIDs, now); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// InsertWorkCorrections stores correction records as given (ids and
// timestamps are filled in when empty). Manual corrections made through
// UpdateWorkClassifications are recorded there; this is for importing a
// labelled sample.
func (s *SQLStore) InsertWorkCorrections(ctx context.Context, corrections []WorkCorrection) error {
	return s.insertWorkCorrections(ctx, s.db, corrections)
}

func (s *SQLStore) insertWorkCorrections(ctx context.Context, q workQuerier, corrections []WorkCorrection) error {
	args := make([]any, 0, len(corrections)*12)
	now := workIntelTime(time.Now())
	for _, c := range corrections {
		if c.ID == "" {
			c.ID = newStoreID("wcor")
		}
		c.CreatedAt = normalizeWorkIntelTime(c.CreatedAt)
		if c.CreatedAt == "" {
			c.CreatedAt = now
		}
		args = append(args, c.ID, c.RequestID, c.FromCategoryID, c.ToCategoryID, c.FromAction, c.ToAction, c.FromMethod,
			c.FromConfidence, c.PolicyVersion, c.Actor, c.Reason, c.CreatedAt)
	}
	_, err := s.workBatchExec(ctx, q, `INSERT INTO work_corrections (id, request_id, from_category_id, to_category_id, from_action,
		to_action, from_method, from_confidence, policy_version, actor, reason, created_at)`,
		workRowPlaceholder(12), `ON CONFLICT(id) DO NOTHING`, 12, args)
	return err
}

// ListWorkCorrections returns the newest corrections, newest first. They are
// the labelled sample a policy is evaluated against.
func (s *SQLStore) ListWorkCorrections(ctx context.Context, limit int) ([]WorkCorrection, error) {
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, request_id, from_category_id, to_category_id, from_action, to_action,
			from_method, from_confidence, policy_version, actor, reason, created_at
		FROM work_corrections ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkCorrection{}
	for rows.Next() {
		var c WorkCorrection
		if err := rows.Scan(&c.ID, &c.RequestID, &c.FromCategoryID, &c.ToCategoryID, &c.FromAction, &c.ToAction,
			&c.FromMethod, &c.FromConfidence, &c.PolicyVersion, &c.Actor, &c.Reason, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// workDailyRebuildSelect computes the daily aggregate of one day from its
// facts. The bucket bounds are written into the statement from the same
// constants the incremental path buckets with.
var workDailyRebuildSelect = func() string {
	sum := func(cond string) string { return "COALESCE(SUM(CASE WHEN " + cond + " THEN 1 ELSE 0 END), 0)" }
	cols := []string{"COUNT(*)", "COALESCE(SUM(tokens_in), 0)", "COALESCE(SUM(tokens_out), 0)", "COALESCE(SUM(cost_krw), 0)",
		"COALESCE(SUM(mcp_calls), 0)", "COALESCE(SUM(is_error), 0)", "COALESCE(SUM(is_retry), 0)", "COALESCE(SUM(latency_ms), 0)"}
	for i := 0; i < workintel.LatencyBuckets; i++ {
		var cond []string
		if i > 0 {
			cond = append(cond, "latency_ms > "+strconv.FormatInt(workintel.LatencyBounds[i-1], 10))
		}
		if i < len(workintel.LatencyBounds) {
			cond = append(cond, "latency_ms <= "+strconv.FormatInt(workintel.LatencyBounds[i], 10))
		}
		cols = append(cols, sum(strings.Join(cond, " AND ")))
	}
	for _, m := range workDailyMethods {
		cols = append(cols, sum("method = '"+m+"'"))
	}
	for _, st := range workDailyStatuses {
		cols = append(cols, sum("status = '"+st+"'"))
	}
	bound := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	for i := 0; i < workConfidenceBuckets; i++ {
		var cond []string
		if i > 0 {
			cond = append(cond, "confidence >= "+bound(workConfidenceBounds[i-1]))
		}
		if i < len(workConfidenceBounds) {
			cond = append(cond, "confidence < "+bound(workConfidenceBounds[i]))
		}
		cols = append(cols, sum(strings.Join(cond, " AND ")))
	}
	return "SELECT " + workDailyKeyColumns + ", MIN(top_category_id), " + strings.Join(cols, ", ") +
		" FROM work_classifications WHERE day = ? GROUP BY " + workDailyKeyColumns
}()

// factsPurgedBefore reads the facts purge mark inside a transaction.
func (s *SQLStore) factsPurgedBefore(ctx context.Context, tx *sql.Tx) (time.Time, error) {
	var raw string
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT facts_purged_before FROM work_intel_state WHERE id = ?`), workIntelStateID).Scan(&raw); err != nil {
		return time.Time{}, err
	}
	t, _ := parseStoredTime(raw)
	return t, nil
}

// RebuildWorkDays regenerates work_daily and work_daily_users of the given
// days from the facts: delete, then INSERT … SELECT, one transaction per day.
// Afterwards the aggregates of those days are exactly what their facts say.
//
// A day that begins before the facts purge mark is not rebuilt (it is
// returned in SkippedDays): part of its facts went with their requests, and a
// recount would silently shrink a day that was counted correctly at the time.
func (s *SQLStore) RebuildWorkDays(ctx context.Context, days []string) (WorkRebuildResult, error) {
	result := WorkRebuildResult{Days: []string{}, SkippedDays: []string{}}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return result, err
	}
	seen := map[string]bool{}
	for _, day := range days {
		if seen[day] {
			continue
		}
		seen[day] = true
		start, ok := workIntelDayStart(day)
		if !ok {
			return result, fmt.Errorf("work intel: %q is not a day (YYYY-MM-DD)", day)
		}
		rebuilt, err := s.rebuildWorkDay(ctx, day, start)
		if err != nil {
			return result, err
		}
		if rebuilt {
			result.Days = append(result.Days, day)
		} else {
			result.SkippedDays = append(result.SkippedDays, day)
		}
	}
	return result, nil
}

func (s *SQLStore) rebuildWorkDay(ctx context.Context, day string, start time.Time) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err := s.lockWorkIntelTx(ctx, tx); err != nil {
		return false, err
	}
	purged, err := s.factsPurgedBefore(ctx, tx)
	if err != nil {
		return false, err
	}
	// The mark is removed either way: a frozen day cannot be rebuilt later
	// either, and leaving it would make the worker try again every minute.
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_intel_dirty WHERE kind = ? AND ref = ?`), workIntelDirtyDay, day); err != nil {
		return false, err
	}
	if !purged.IsZero() && start.Before(purged) {
		return false, tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_daily WHERE day = ?`), day); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(workDailyInsertHeader+" "+workDailyRebuildSelect), day); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_daily_users WHERE day = ?`), day); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO work_daily_users (day, category_id, team, user_key, top_category_id)
		SELECT day, category_id, team, user_key, MIN(top_category_id)
		FROM work_classifications WHERE day = ? GROUP BY day, category_id, team, user_key`), day); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// workSessionRebuildChunk bounds how many sessions one transaction rebuilds.
const workSessionRebuildChunk = 100

// RebuildWorkSessions regenerates the session heads and segments of the given
// session ids (every team that used the id) from the facts, replaying them in
// ingestion order through the same code the incremental path uses. It returns
// how many session ids were rebuilt and how many were kept because they reach
// back before the facts purge mark.
func (s *SQLStore) RebuildWorkSessions(ctx context.Context, sessionIDs []string) (WorkRebuildResult, error) {
	result := WorkRebuildResult{Days: []string{}, SkippedDays: []string{}}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return result, err
	}
	ids := make([]string, 0, len(sessionIDs))
	seen := map[string]bool{}
	for _, id := range sessionIDs {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, chunk := range workChunks(ids, workSessionRebuildChunk) {
		rebuilt, skipped, err := s.rebuildWorkSessionChunk(ctx, chunk)
		if err != nil {
			return result, err
		}
		result.Sessions += rebuilt
		result.SkippedSessions += skipped
	}
	return result, nil
}

func (s *SQLStore) rebuildWorkSessionChunk(ctx context.Context, sessionIDs []string) (rebuilt, skipped int, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	if err := s.lockWorkIntelTx(ctx, tx); err != nil {
		return 0, 0, err
	}
	now := workIntelTime(time.Now())
	in := placeholders(len(sessionIDs))
	args := workAnyArgs(sessionIDs)

	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_intel_dirty WHERE kind = ? AND ref IN (`+in+`)`),
		append([]any{workIntelDirtySession}, args...)...); err != nil {
		return 0, 0, err
	}

	// A session that began before the purge mark has lost facts; what is
	// stored for it is kept.
	purged, err := s.factsPurgedBefore(ctx, tx)
	if err != nil {
		return 0, 0, err
	}
	keep := sessionIDs
	if !purged.IsZero() {
		stored, err := s.loadWorkSessionHeads(ctx, tx, sessionIDs)
		if err != nil {
			return 0, 0, err
		}
		frozen := map[string]bool{}
		mark := workIntelTime(purged)
		for key, head := range stored {
			if head.FirstAt < mark {
				frozen[key.SessionID] = true
			}
		}
		if len(frozen) > 0 {
			keep = make([]string, 0, len(sessionIDs))
			for _, id := range sessionIDs {
				if !frozen[id] {
					keep = append(keep, id)
				}
			}
			skipped = len(frozen)
		}
	}
	if len(keep) == 0 {
		return 0, skipped, tx.Commit()
	}
	in, args = placeholders(len(keep)), workAnyArgs(keep)

	confirmed := map[workSessionKey]bool{}
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT DISTINCT c.session_id, c.team
		FROM llm_feedback f
		JOIN work_classifications c ON c.request_id = f.request_id
		WHERE c.session_id IN (`+in+`) AND f.rating > 0`), args...)
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var key workSessionKey
		if err := rows.Scan(&key.SessionID, &key.Team); err != nil {
			rows.Close()
			return 0, 0, err
		}
		confirmed[key] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, 0, err
	}

	builder := newWorkSessionBuilder(nil)
	rows, err = tx.QueryContext(ctx, s.bind(`SELECT request_id, created_at, ingested_at, day, session_id, session_kind, team, user_key,
			client, model, category_id, top_category_id, fingerprint, tokens_in, tokens_out, cost_krw, latency_ms,
			is_error, is_retry, mcp_calls, policy_flags
		FROM work_classifications WHERE session_id IN (`+in+`)
		ORDER BY session_id, ingested_at, request_id`), args...)
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var f WorkClassification
		var flags string
		var isError, isRetry int
		if err := rows.Scan(&f.RequestID, &f.CreatedAt, &f.IngestedAt, &f.Day, &f.SessionID, &f.SessionKind, &f.Team, &f.UserKey,
			&f.Client, &f.Model, &f.CategoryID, &f.TopCategoryID, &f.Fingerprint, &f.TokensIn, &f.TokensOut, &f.CostKRW, &f.LatencyMS,
			&isError, &isRetry, &f.MCPCalls, &flags); err != nil {
			rows.Close()
			return 0, 0, err
		}
		f.IsError, f.IsRetry, f.PolicyFlags = isError != 0, isRetry != 0, workSplitFlags(flags)
		// IsRetry was decided when the fact was written and is a property of
		// the request sequence, not of its classification: it is replayed, not
		// decided again.
		builder.add(&f, false)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, 0, err
	}

	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_session_segments WHERE session_id IN (`+in+`)`), args...); err != nil {
		return 0, 0, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_sessions WHERE session_id IN (`+in+`)`), args...); err != nil {
		return 0, 0, err
	}
	heads := make([]*workSessionHead, 0, len(builder.heads))
	for key, head := range builder.heads {
		if confirmed[key] {
			head.PositiveFeedback = true
		}
		heads = append(heads, head)
	}
	sort.Slice(heads, func(i, j int) bool {
		if heads[i].Key.SessionID != heads[j].Key.SessionID {
			return heads[i].Key.SessionID < heads[j].Key.SessionID
		}
		return heads[i].Key.Team < heads[j].Key.Team
	})
	if err := s.writeWorkSessionHeads(ctx, tx, heads, now); err != nil {
		return 0, 0, err
	}
	segments := make([]*workSegment, 0, len(builder.segments))
	for _, seg := range builder.segments {
		segments = append(segments, seg)
	}
	sort.Slice(segments, func(i, j int) bool { return workSegmentLess(segments[i].Key, segments[j].Key) })
	if err := s.writeWorkSegments(ctx, tx, segments); err != nil {
		return 0, 0, err
	}
	return len(keep), skipped, tx.Commit()
}

// RebuildWorkSessionsOfDays rebuilds every session that has a fact on one of
// the given days. It is the session half of a full rebuild of a period.
func (s *SQLStore) RebuildWorkSessionsOfDays(ctx context.Context, days []string) (WorkRebuildResult, error) {
	total := WorkRebuildResult{Days: []string{}, SkippedDays: []string{}}
	for _, day := range days {
		rows, err := s.db.QueryContext(ctx, s.bind(`SELECT DISTINCT session_id FROM work_classifications WHERE day = ?`), day)
		if err != nil {
			return total, err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return total, err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return total, err
		}
		part, err := s.RebuildWorkSessions(ctx, ids)
		if err != nil {
			return total, err
		}
		total.Sessions += part.Sessions
		total.SkippedSessions += part.SkippedSessions
	}
	return total, nil
}

// WorkIntelDirty returns the days and sessions waiting for a rebuild, oldest
// mark first, at most limit of each.
func (s *SQLStore) WorkIntelDirty(ctx context.Context, limit int) (days, sessionIDs []string, err error) {
	if limit <= 0 {
		limit = 200
	}
	read := func(kind string) ([]string, error) {
		rows, err := s.db.QueryContext(ctx, s.bind(`SELECT ref FROM work_intel_dirty WHERE kind = ? ORDER BY marked_at ASC, ref ASC LIMIT ?`), kind, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var ref string
			if err := rows.Scan(&ref); err != nil {
				return nil, err
			}
			out = append(out, ref)
		}
		return out, rows.Err()
	}
	if days, err = read(workIntelDirtyDay); err != nil {
		return nil, nil, err
	}
	sessionIDs, err = read(workIntelDirtySession)
	return days, sessionIDs, err
}

// RebuildWorkIntelDirty regenerates the aggregates recorded as stale, up to
// limit days and limit sessions, and removes their marks. The worker calls it
// on a throttle after reassignments; anything left is picked up next time,
// also after a restart.
func (s *SQLStore) RebuildWorkIntelDirty(ctx context.Context, limit int) (WorkRebuildResult, error) {
	result := WorkRebuildResult{Days: []string{}, SkippedDays: []string{}}
	days, sessionIDs, err := s.WorkIntelDirty(ctx, limit)
	if err != nil {
		return result, err
	}
	if len(days) > 0 {
		part, err := s.RebuildWorkDays(ctx, days)
		if err != nil {
			return result, err
		}
		result.Days, result.SkippedDays = part.Days, part.SkippedDays
	}
	if len(sessionIDs) > 0 {
		part, err := s.RebuildWorkSessions(ctx, sessionIDs)
		if err != nil {
			return result, err
		}
		result.Sessions, result.SkippedSessions = part.Sessions, part.SkippedSessions
	}
	return result, nil
}
