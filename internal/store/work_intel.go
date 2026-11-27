package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/workintel"
)

// Work intelligence storage (docs/WORK_INTELLIGENCE_DESIGN.md).
//
// The classification worker reads request_logs behind a cursor and writes one
// fact per request (work_classifications) together with the aggregates the
// dashboards read (work_daily, work_daily_users, work_sessions,
// work_session_segments). Nothing here runs on the request path.
//
// Three rules keep the aggregates equal to the facts:
//
//   - A batch is applied in one transaction: facts, the aggregate deltas of the
//     facts that were actually inserted, and the cursor. Applying it again
//     changes nothing.
//   - Every writer of the aggregates first locks the single work_intel_state
//     row, so a batch, a reassignment and a rebuild never interleave, on one
//     instance or several.
//   - A reassignment (LLM retry, manual correction, reclassification) only
//     updates facts and records the affected days and sessions in
//     work_intel_dirty in the same transaction; the rebuild that follows
//     regenerates their aggregates from the facts and removes the marks.
//
// Timestamps written by this file use the fixed-width layout of
// request_logs.ingested_at, so MIN/MAX and range comparisons on the stored
// text are chronological. Days are Seoul calendar days (YYYY-MM-DD).

const (
	workIntelStateID  = "classifier"
	workPolicyDraftID = "draft"

	// WorkIntelMaxBatch bounds one batch. It keeps every "IN (...)" list of a
	// batch inside the parameter limit that works on all supported databases.
	WorkIntelMaxBatch = 500

	workIntelDirtyDay     = "day"
	workIntelDirtySession = "session"

	// WorkIntelBacklogCap is where the backlog count stops. Counting further
	// would turn a status read into a scan of an arbitrarily long queue.
	WorkIntelBacklogCap = 100000

	// workLanguageMinConfidence keeps only languages detected from a code fence
	// or a file extension. A language guessed from a stray keyword would count
	// as evidence of software work.
	workLanguageMinConfidence = 0.9

	workSessionMaxModels     = 12
	workSessionMaxCategories = 24
	workToolSigMaxTools      = 12
	workToolNameMaxBytes     = 64
)

// Session completion states. A successful API call is never taken as a
// finished piece of work; only explicit positive feedback confirms it.
const (
	WorkCompletionUnknown   = "unknown"
	WorkCompletionError     = "ended_with_error"
	WorkCompletionConfirmed = "confirmed"
)

// Policy flags recorded on a fact and its session.
const (
	WorkFlagDLP    = "dlp"
	WorkFlagSecret = "secret"
)

var (
	// ErrWorkPolicyConflict means another administrator saved the draft since
	// the caller read it.
	ErrWorkPolicyConflict = errors.New("work policy changed concurrently")
	// ErrWorkIntelCursorMoved means another worker applied a batch since this
	// one read the cursor. Nothing was written; the batch is simply read again.
	ErrWorkIntelCursorMoved = errors.New("work intel cursor was advanced by another worker")
	// ErrWorkIntelJobActive means a job is already queued or running.
	ErrWorkIntelJobActive = errors.New("another work intel job is active")
	// ErrWorkIntelJobConflict means the job is no longer owned by this worker.
	ErrWorkIntelJobConflict = errors.New("work intel job no longer owns its lease")
)

// WorkIntelCursor is a position in request_logs, in (ingested_at, id) order.
type WorkIntelCursor struct {
	IngestedAt string `json:"ingested_at"`
	RequestID  string `json:"request_id"`
}

// After reports whether c lies strictly after other.
func (c WorkIntelCursor) After(other WorkIntelCursor) bool {
	if c.IngestedAt != other.IngestedAt {
		return c.IngestedAt > other.IngestedAt
	}
	return c.RequestID > other.RequestID
}

// WorkIntelState is the worker's state row.
type WorkIntelState struct {
	Cursor      WorkIntelCursor `json:"cursor"`
	WorkerToken string          `json:"-"`
	LeaseUntil  string          `json:"lease_until"`
	// StatsJSON is the compact statistics document the worker persists each
	// cycle. Its shape belongs to the proxy package.
	StatsJSON string `json:"-"`
	// FactsPurgedBefore is the time before which classification facts were
	// deleted with their requests. Days that start before it are frozen.
	FactsPurgedBefore string `json:"facts_purged_before"`
	PeriodicAt        string `json:"periodic_at"`
	UpdatedAt         string `json:"updated_at"`
}

// LeaseActive reports whether some worker holds an unexpired lease at now.
func (st WorkIntelState) LeaseActive(now time.Time) bool {
	return st.WorkerToken != "" && st.LeaseUntil >= workIntelTime(now)
}

// WorkClassification is one row of work_classifications: the classification
// of one request with the request facts the aggregates are built from. It
// never holds prompt text; WorkTitle and Tags are redacted labels.
type WorkClassification struct {
	RequestID   string `json:"request_id"`
	CreatedAt   string `json:"created_at"`
	IngestedAt  string `json:"ingested_at"`
	Day         string `json:"day"`
	SessionID   string `json:"session_id"`
	SessionKind string `json:"session_kind"`
	Team        string `json:"team"`
	UserKey     string `json:"user_key"`
	APIKeyID    string `json:"api_key_id"`
	Model       string `json:"model"`
	Provider    string `json:"provider"`
	Client      string `json:"client"`
	Endpoint    string `json:"endpoint"`

	CategoryID      string   `json:"category_id"`
	TopCategoryID   string   `json:"top_category_id"`
	ActionType      string   `json:"action_type"`
	Difficulty      string   `json:"difficulty"`
	Confidence      float64  `json:"confidence"`
	Method          string   `json:"method"`
	ClassifierModel string   `json:"classifier_model"`
	PolicyVersion   int      `json:"policy_version"`
	Status          string   `json:"status"`
	Tags            []string `json:"tags"`
	Technologies    []string `json:"technologies"`
	TargetSystem    string   `json:"target_system"`
	WorkTitle       string   `json:"work_title"`
	NewCategoryHint string   `json:"new_category_hint"`

	Language    string  `json:"language"`
	Fingerprint string  `json:"fingerprint"`
	TokensIn    int64   `json:"tokens_in"`
	TokensOut   int64   `json:"tokens_out"`
	CostKRW     float64 `json:"cost_krw"`
	LatencyMS   int64   `json:"latency_ms"`
	IsError     bool    `json:"is_error"`
	// IsRetry is decided by ApplyWorkIntelBatch: the previous request of the
	// session failed and had the same prompt fingerprint.
	IsRetry     bool     `json:"is_retry"`
	MCPCalls    int64    `json:"mcp_calls"`
	ToolSig     string   `json:"tool_sig"`
	PolicyFlags []string `json:"policy_flags"`

	// NeedsLLM marks a row the semantic step should still look at; LLMAttempts
	// counts the failed tries.
	NeedsLLM    bool   `json:"needs_llm"`
	LLMAttempts int    `json:"llm_attempts"`
	CorrectedBy string `json:"corrected_by"`
	CorrectedAt string `json:"corrected_at"`
	UpdatedAt   string `json:"updated_at"`

	// PositiveFeedback is an input of ApplyWorkIntelBatch only (it confirms the
	// session); it is not a column of the fact.
	PositiveFeedback bool `json:"-"`
}

// SetResult copies a classification result into the fact. The caller is
// responsible for having redacted the title, tags and hint.
func (c *WorkClassification) SetResult(res workintel.Result, policyVersion int, classifierModel string) {
	c.CategoryID = res.CategoryID
	c.TopCategoryID = res.TopCategoryID
	if c.CategoryID == "" {
		c.CategoryID = workintel.OtherCategoryID
	}
	if c.TopCategoryID == "" {
		c.TopCategoryID = workTopCategory(c.CategoryID)
	}
	c.ActionType = res.ActionType
	if res.Difficulty != "" {
		c.Difficulty = res.Difficulty
	}
	c.Confidence = res.Confidence
	c.Method = res.Method
	c.Status = res.Status
	c.Tags = res.Tags
	c.Technologies = res.Technologies
	c.TargetSystem = res.TargetSystem
	c.WorkTitle = res.WorkTitle
	c.NewCategoryHint = res.NewCategoryHint
	c.PolicyVersion = policyVersion
	c.ClassifierModel = classifierModel
}

// normalize fills the derived and defaulted fields so that every row written
// to the fact table is complete.
func (c *WorkClassification) normalize(now string) {
	c.CreatedAt = normalizeWorkIntelTime(c.CreatedAt)
	if c.CreatedAt == "" {
		c.CreatedAt = now
	}
	if c.Day == "" {
		c.Day = workIntelDayOf(c.CreatedAt)
	}
	if c.SessionKind == "" {
		c.SessionKind = workintel.SessionKind(c.SessionID)
	}
	if c.CategoryID == "" {
		c.CategoryID = workintel.OtherCategoryID
	}
	if c.TopCategoryID == "" {
		c.TopCategoryID = workTopCategory(c.CategoryID)
	}
	if c.ActionType == "" {
		c.ActionType = workintel.UnknownAction
	}
	if c.Method == "" {
		c.Method = workintel.MethodRule
	}
	if c.Status == "" {
		c.Status = workintel.StatusClassified
	}
	c.UpdatedAt = now
}

// workTopCategory returns the top-level id a category id belongs to. The
// level is encoded in the id ("dev.codegen.api" is under "dev").
func workTopCategory(id string) string {
	if i := strings.IndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return id
}

// workIntelTime formats a time in the fixed-width UTC layout used by every
// work-intel table.
func workIntelTime(t time.Time) string {
	return formatXViewIngestedAt(t)
}

// normalizeWorkIntelTime rewrites a stored timestamp into the fixed-width
// layout. Text that is not a timestamp is returned unchanged rather than
// dropped, so a malformed source row stays visible.
func normalizeWorkIntelTime(raw string) string {
	if t, ok := parseStoredTime(raw); ok {
		return workIntelTime(t)
	}
	return raw
}

// WorkIntelDay returns the Seoul calendar day a time belongs to.
func WorkIntelDay(t time.Time) string {
	return t.In(seoulZone).Format("2006-01-02")
}

func workIntelDayOf(stored string) string {
	if t, ok := parseStoredTime(stored); ok {
		return WorkIntelDay(t)
	}
	if len(stored) >= 10 {
		return stored[:10]
	}
	return ""
}

// workIntelDayStart returns the instant a Seoul day begins.
func workIntelDayStart(day string) (time.Time, bool) {
	t, err := time.ParseInLocation("2006-01-02", day, seoulZone)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func workEncodeList(values []string) string {
	return encodeList(values)
}

func workJoinFlags(flags []string) string {
	if len(flags) == 0 {
		return ""
	}
	out := append([]string(nil), flags...)
	sort.Strings(out)
	uniq := out[:0]
	for _, f := range out {
		if f = strings.TrimSpace(f); f != "" && (len(uniq) == 0 || uniq[len(uniq)-1] != f) {
			uniq = append(uniq, f)
		}
	}
	return strings.Join(uniq, ",")
}

func workSplitFlags(raw string) []string {
	out := []string{}
	for _, f := range strings.Split(raw, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// workChunks splits ids into slices that fit one IN list.
func workChunks(ids []string, size int) [][]string {
	if size <= 0 {
		size = WorkIntelMaxBatch
	}
	var out [][]string
	for start := 0; start < len(ids); start += size {
		end := start + size
		if end > len(ids) {
			end = len(ids)
		}
		out = append(out, ids[start:end])
	}
	return out
}

func workAnyArgs(ids []string) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}

// workQuerier is satisfied by *sql.DB and *sql.Tx. Readers that are also
// needed inside a transaction take it, because on SQLite the pool has one
// connection and a query outside the open transaction would wait for it
// forever.
type workQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// workBatchExec runs a multi-row statement in chunks that stay under the
// bound-parameter limit. header is the statement up to and including the
// column list; suffix follows the VALUES rows (an ON CONFLICT clause). It
// returns the number of rows the database reports as written.
func (s *SQLStore) workBatchExec(ctx context.Context, q workQuerier, header, rowPlaceholder, suffix string, perRow int, args []any) (int64, error) {
	if len(args) == 0 {
		return 0, nil
	}
	if perRow <= 0 || len(args)%perRow != 0 {
		return 0, errBatchArgsMismatch
	}
	rows := len(args) / perRow
	perStatement := batchParamLimit / perRow
	if perStatement < 1 {
		perStatement = 1
	}
	var written int64
	for start := 0; start < rows; start += perStatement {
		end := start + perStatement
		if end > rows {
			end = rows
		}
		placeholders := make([]string, 0, end-start)
		for i := start; i < end; i++ {
			placeholders = append(placeholders, rowPlaceholder)
		}
		stmt := s.bind(header + " VALUES " + strings.Join(placeholders, ", ") + " " + suffix)
		res, err := q.ExecContext(ctx, stmt, cleanArgs(args[start*perRow:end*perRow])...)
		if err != nil {
			return written, err
		}
		if n, err := res.RowsAffected(); err == nil {
			written += n
		}
	}
	return written, nil
}

func workRowPlaceholder(n int) string {
	return "(" + placeholders(n) + ")"
}

// ensureWorkIntelState creates the state row. Concurrent callers on several
// instances all succeed: the insert is a no-op for everyone but the first.
func (s *SQLStore) ensureWorkIntelState(ctx context.Context, q workQuerier) error {
	_, err := q.ExecContext(ctx, s.bind(`INSERT INTO work_intel_state (id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`),
		workIntelStateID, workIntelTime(time.Now()))
	return err
}

// lockWorkIntelTx takes the lock every writer of the work-intel aggregates
// holds until it commits. On PostgreSQL the no-op update is a row lock; on
// SQLite it is the database write lock, taken before any read so the
// transaction never has to upgrade a stale snapshot.
func (s *SQLStore) lockWorkIntelTx(ctx context.Context, tx *sql.Tx) error {
	for attempt := 0; attempt < 2; attempt++ {
		res, err := tx.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET updated_at = updated_at WHERE id = ?`), workIntelStateID)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n == 1 {
			return nil
		}
		if err := s.ensureWorkIntelState(ctx, tx); err != nil {
			return err
		}
	}
	return errors.New("work intel state row is missing")
}

// GetWorkIntelState returns the worker's state row, creating it on first use.
func (s *SQLStore) GetWorkIntelState(ctx context.Context) (WorkIntelState, error) {
	for attempt := 0; attempt < 2; attempt++ {
		var st WorkIntelState
		err := s.db.QueryRowContext(ctx, s.bind(`SELECT cursor_ingested_at, cursor_id, worker_token, lease_until, stats_json,
				facts_purged_before, periodic_at, updated_at
			FROM work_intel_state WHERE id = ?`), workIntelStateID).
			Scan(&st.Cursor.IngestedAt, &st.Cursor.RequestID, &st.WorkerToken, &st.LeaseUntil, &st.StatsJSON,
				&st.FactsPurgedBefore, &st.PeriodicAt, &st.UpdatedAt)
		if err == nil {
			return st, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return WorkIntelState{}, err
		}
		if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
			return WorkIntelState{}, err
		}
	}
	return WorkIntelState{}, errors.New("work intel state row is missing")
}

// AcquireWorkIntelLease makes token the worker for ttl. It succeeds when the
// lease is free, expired, or already held by token (a renewal); otherwise it
// reports false and changes nothing. There is no leader election in this
// gateway: the instance whose update wins the row is the worker.
func (s *SQLStore) AcquireWorkIntelLease(ctx context.Context, token string, ttl time.Duration) (bool, error) {
	if token == "" || ttl <= 0 {
		return false, errors.New("work intel lease needs a token and a positive ttl")
	}
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return false, err
	}
	now := time.Now()
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET worker_token = ?, lease_until = ?
		WHERE id = ? AND (worker_token = ? OR worker_token = '' OR lease_until < ?)`),
		token, workIntelTime(now.Add(ttl)), workIntelStateID, token, workIntelTime(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ReleaseWorkIntelLease gives the lease up if token still holds it, so another
// instance can take over without waiting for it to expire.
func (s *SQLStore) ReleaseWorkIntelLease(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET worker_token = '', lease_until = ''
		WHERE id = ? AND worker_token = ?`), workIntelStateID, token)
	return err
}

// InitWorkIntelCursor sets the starting position of a worker that has never
// run. It is a no-op once a cursor exists, so concurrent first runs agree on
// whichever value was written first.
func (s *SQLStore) InitWorkIntelCursor(ctx context.Context, start time.Time) (WorkIntelCursor, error) {
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return WorkIntelCursor{}, err
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET cursor_ingested_at = ?, cursor_id = '', updated_at = ?
		WHERE id = ? AND cursor_ingested_at = ''`),
		workIntelTime(start), workIntelTime(time.Now()), workIntelStateID); err != nil {
		return WorkIntelCursor{}, err
	}
	st, err := s.GetWorkIntelState(ctx)
	return st.Cursor, err
}

// SaveWorkIntelStats stores the worker's statistics document while token
// holds the lease. A worker that lost the lease writes nothing, so it cannot
// overwrite its successor's numbers.
func (s *SQLStore) SaveWorkIntelStats(ctx context.Context, token, statsJSON string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET stats_json = ?, updated_at = ?
		WHERE id = ? AND worker_token = ?`),
		cleanArgs([]any{statsJSON, workIntelTime(time.Now()), workIntelStateID, token})...)
	return err
}

// MarkWorkIntelPeriodic records when the periodic step last ran, so a restart
// or a change of worker does not run it again before its interval.
func (s *SQLStore) MarkWorkIntelPeriodic(ctx context.Context, at time.Time) error {
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET periodic_at = ? WHERE id = ?`),
		workIntelTime(at), workIntelStateID)
	return err
}

// noteWorkIntelFactsPurged moves the "facts purged before" mark forward. It is
// called by the retention purge of request_logs.
func (s *SQLStore) noteWorkIntelFactsPurged(ctx context.Context, cutoff time.Time) error {
	if err := s.ensureWorkIntelState(ctx, s.db); err != nil {
		return err
	}
	mark := workIntelTime(cutoff)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_state SET facts_purged_before = ?
		WHERE id = ? AND facts_purged_before < ?`), mark, workIntelStateID, mark)
	return err
}

// workIntelAfterCursor is the predicate for rows strictly after a cursor. The
// first comparison is the one the (ingested_at, id) index seeks on; the second
// only removes the cursor row and its earlier ids.
const workIntelAfterCursor = `ingested_at >= ? AND (ingested_at > ? OR id > ?) AND ingested_at <> ''`

// WorkIntelBacklog returns how many requests are waiting behind the cursor and
// how long the oldest of them has waited. The count stops at
// WorkIntelBacklogCap (capped is then true). Both come from the cursor index
// and read no request content.
func (s *SQLStore) WorkIntelBacklog(ctx context.Context) (count int64, capped bool, lag time.Duration, err error) {
	st, err := s.GetWorkIntelState(ctx)
	if err != nil {
		return 0, false, 0, err
	}
	if st.Cursor.IngestedAt == "" {
		// The worker has not chosen a starting point yet, so nothing is queued.
		return 0, false, 0, nil
	}
	args := []any{st.Cursor.IngestedAt, st.Cursor.IngestedAt, st.Cursor.RequestID}
	if err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM (
			SELECT 1 FROM request_logs WHERE `+workIntelAfterCursor+` LIMIT ?
		) capped`), append(args, WorkIntelBacklogCap+1)...).Scan(&count); err != nil {
		return 0, false, 0, err
	}
	if count > WorkIntelBacklogCap {
		count, capped = WorkIntelBacklogCap, true
	}
	if count == 0 {
		return 0, false, 0, nil
	}
	var oldest string
	err = s.db.QueryRowContext(ctx, s.bind(`SELECT ingested_at FROM request_logs
		WHERE `+workIntelAfterCursor+` ORDER BY ingested_at ASC, id ASC LIMIT 1`), args...).Scan(&oldest)
	if errors.Is(err, sql.ErrNoRows) {
		return count, capped, 0, nil
	}
	if err != nil {
		return 0, false, 0, err
	}
	if t, ok := parseStoredTime(oldest); ok {
		if lag = time.Since(t); lag < 0 {
			lag = 0
		}
	}
	return count, capped, lag, nil
}

// workScanFact is the column list every fact reader selects, in the order
// scanWorkFact expects.
const workFactColumns = `request_id, created_at, ingested_at, day, session_id, session_kind, team, user_key, api_key_id,
	model, provider, client, endpoint, category_id, top_category_id, action_type, difficulty, confidence, method,
	classifier_model, policy_version, status, tags, technologies, target_system, work_title, new_category_hint,
	language, fingerprint, tokens_in, tokens_out, cost_krw, latency_ms, is_error, is_retry, mcp_calls, tool_sig,
	policy_flags, needs_llm, llm_attempts, corrected_by, corrected_at, updated_at`

const workFactColumnCount = 43

type workRowScanner interface {
	Scan(dest ...any) error
}

func scanWorkFact(row workRowScanner) (WorkClassification, error) {
	var c WorkClassification
	var tags, techs, flags string
	var isError, isRetry, needsLLM int
	err := row.Scan(&c.RequestID, &c.CreatedAt, &c.IngestedAt, &c.Day, &c.SessionID, &c.SessionKind, &c.Team, &c.UserKey, &c.APIKeyID,
		&c.Model, &c.Provider, &c.Client, &c.Endpoint, &c.CategoryID, &c.TopCategoryID, &c.ActionType, &c.Difficulty, &c.Confidence, &c.Method,
		&c.ClassifierModel, &c.PolicyVersion, &c.Status, &tags, &techs, &c.TargetSystem, &c.WorkTitle, &c.NewCategoryHint,
		&c.Language, &c.Fingerprint, &c.TokensIn, &c.TokensOut, &c.CostKRW, &c.LatencyMS, &isError, &isRetry, &c.MCPCalls, &c.ToolSig,
		&flags, &needsLLM, &c.LLMAttempts, &c.CorrectedBy, &c.CorrectedAt, &c.UpdatedAt)
	if err != nil {
		return c, err
	}
	c.Tags, c.Technologies, c.PolicyFlags = decodeList(tags), decodeList(techs), workSplitFlags(flags)
	c.IsError, c.IsRetry, c.NeedsLLM = isError != 0, isRetry != 0, needsLLM != 0
	return c, nil
}

func workFactArgs(c *WorkClassification) []any {
	return []any{c.RequestID, c.CreatedAt, c.IngestedAt, c.Day, c.SessionID, c.SessionKind, c.Team, c.UserKey, c.APIKeyID,
		c.Model, c.Provider, c.Client, c.Endpoint, c.CategoryID, c.TopCategoryID, c.ActionType, c.Difficulty, c.Confidence, c.Method,
		c.ClassifierModel, c.PolicyVersion, c.Status, workEncodeList(c.Tags), workEncodeList(c.Technologies), c.TargetSystem, c.WorkTitle, c.NewCategoryHint,
		c.Language, c.Fingerprint, c.TokensIn, c.TokensOut, c.CostKRW, c.LatencyMS, boolInt(c.IsError), boolInt(c.IsRetry), c.MCPCalls, c.ToolSig,
		workJoinFlags(c.PolicyFlags), boolInt(c.NeedsLLM), c.LLMAttempts, c.CorrectedBy, c.CorrectedAt, c.UpdatedAt}
}

// WorkClassificationsByID returns the facts of the given requests. Requests
// that have not been classified are simply absent from the result.
func (s *SQLStore) WorkClassificationsByID(ctx context.Context, requestIDs []string) ([]WorkClassification, error) {
	return s.workFactsByID(ctx, s.db, requestIDs)
}

func (s *SQLStore) workFactsByID(ctx context.Context, q workQuerier, requestIDs []string) ([]WorkClassification, error) {
	out := make([]WorkClassification, 0, len(requestIDs))
	for _, chunk := range workChunks(requestIDs, WorkIntelMaxBatch) {
		rows, err := q.QueryContext(ctx, s.bind(`SELECT `+workFactColumns+` FROM work_classifications
			WHERE request_id IN (`+placeholders(len(chunk))+`)`), workAnyArgs(chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			c, err := scanWorkFact(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, c)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// WorkIntelPendingLLM returns up to limit facts that still wait for the
// semantic step and have failed fewer than maxAttempts times: the least-tried
// first, and within those the newest first, so one request that keeps failing
// cannot hold the queue.
//
// A fact that has already failed is only offered again after a pause that
// grows with its failures (backoff after the first, four times that after the
// second), measured from its last update. Without it three attempts would be
// spent within three cycles and a model that is down for two minutes would
// cost every request of those minutes its semantic result.
func (s *SQLStore) WorkIntelPendingLLM(ctx context.Context, limit, maxAttempts int, backoff time.Duration) ([]WorkClassification, error) {
	if limit <= 0 || maxAttempts <= 0 {
		return []WorkClassification{}, nil
	}
	if limit > WorkIntelMaxBatch {
		limit = WorkIntelMaxBatch
	}
	now := time.Now()
	out := make([]WorkClassification, 0, limit)
	// One query per attempt count: with both leading columns fixed, the pending
	// index returns the newest rows without sorting the whole queue.
	for attempts := 0; attempts < maxAttempts && len(out) < limit; attempts++ {
		notAfter := workIntelTime(now.Add(-backoff * time.Duration(attempts*attempts)))
		if attempts == 0 || backoff <= 0 {
			// Never tried, or no pause asked for: everything is eligible.
			notAfter = workIntelTime(now.Add(time.Hour))
		}
		rows, err := s.db.QueryContext(ctx, s.bind(`SELECT `+workFactColumns+` FROM work_classifications
			WHERE needs_llm = 1 AND llm_attempts = ? AND updated_at <= ? ORDER BY created_at DESC LIMIT ?`), attempts, notAfter, limit-len(out))
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			c, err := scanWorkFact(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, c)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// WorkMethodAccuracy measures each classification method against the
// administrator corrections made since the given time: a correction that kept
// the category counts as a correct result, one that changed it as a wrong one.
func (s *SQLStore) WorkMethodAccuracy(ctx context.Context, since time.Time) (map[string]workintel.MethodAccuracy, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT from_method, COUNT(*),
			COALESCE(SUM(CASE WHEN from_category_id = to_category_id THEN 1 ELSE 0 END), 0)
		FROM work_corrections WHERE created_at >= ? GROUP BY from_method`), workIntelTime(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]workintel.MethodAccuracy{}
	for rows.Next() {
		var method string
		var acc workintel.MethodAccuracy
		if err := rows.Scan(&method, &acc.Total, &acc.Correct); err != nil {
			return nil, err
		}
		if method != "" {
			out[method] = acc
		}
	}
	return out, rows.Err()
}

// PurgeWorkIntelOlderThan deletes the aggregates, sessions, insights,
// automation candidates, finished jobs and cache entries older than days.
// They hold no request content, so they live on this clock rather than on the
// request retention; facts and corrections go with their request instead
// (PurgeOlderThan). A non-positive days keeps everything.
func (s *SQLStore) PurgeWorkIntelOlderThan(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	cutoffAt := time.Now().UTC().AddDate(0, 0, -days)
	cutoffDay := WorkIntelDay(cutoffAt)
	cutoff := workIntelTime(cutoffAt)
	var total int64
	for _, stmt := range []struct {
		query string
		arg   string
	}{
		{`DELETE FROM work_daily WHERE day < ?`, cutoffDay},
		{`DELETE FROM work_daily_users WHERE day < ?`, cutoffDay},
		{`DELETE FROM work_session_segments WHERE day < ?`, cutoffDay},
		// A session is kept while it is still being used, however long ago it began.
		{`DELETE FROM work_sessions WHERE last_at < ?`, cutoff},
		{`DELETE FROM work_insights WHERE created_at < ?`, cutoff},
		{`DELETE FROM work_automation_candidates WHERE computed_at < ?`, cutoff},
		{`DELETE FROM work_intel_jobs WHERE updated_at < ? AND status NOT IN ('queued', 'running')`, cutoff},
		{`DELETE FROM work_class_cache WHERE created_at < ?`, cutoff},
	} {
		res, err := s.db.ExecContext(ctx, s.bind(stmt.query), stmt.arg)
		if err != nil {
			return total, err
		}
		if n, err := res.RowsAffected(); err == nil {
			total += n
		}
	}
	return total, nil
}

// workDecodeCounts reads the category_counts document of a session head.
func workDecodeCounts(raw string) map[string]int64 {
	out := map[string]int64{}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}
