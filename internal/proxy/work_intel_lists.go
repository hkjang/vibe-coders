package proxy

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The list reads of work intelligence: sessions, one session, requests and
// the review queue. Lists are paged by the server; the count stops at
// store.WorkCountCap.

// ---- Presentation without a period ----

// workIntelPresenter builds the part of a query that turns stored rows into
// response rows (the caller and the policy), for routes that take no period.
func (s *Server) workIntelPresenter(w http.ResponseWriter, r *http.Request) (*workIntelReadQuery, bool) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return nil, false
	}
	q, err := s.workIntelPresenterFor(r.Context(), caller)
	if err != nil {
		workIntelFailed(w, r, "loading the work policy", err)
		return nil, false
	}
	return q, true
}

func (s *Server) workIntelPresenterFor(ctx context.Context, caller workIntelCaller) (*workIntelReadQuery, error) {
	snap, err := s.workIntelActiveEngine(ctx, workIntelEngineMaxAge)
	if err != nil {
		return nil, err
	}
	q := &workIntelReadQuery{s: s, caller: caller, engine: snap.engine, version: snap.version, metric: "sessions",
		idCache: map[string]map[string]string{}}
	q.base.Teams, q.base.TeamScoped = caller.teams, caller.scoped
	if q.minGroup = q.engine.Thresholds().MinGroupSize; q.minGroup < 1 {
		q.minGroup = 1
	}
	return q, nil
}

// ---- Requests ----

// workRequestView is the request row shared by /requests, /review and the
// session detail.
type workRequestView struct {
	RequestID     string                `json:"request_id"`
	CreatedAt     string                `json:"created_at"`
	SessionID     string                `json:"session_id"`
	Team          string                `json:"team"`
	User          string                `json:"user"`
	Client        string                `json:"client"`
	Model         string                `json:"model"`
	Category      workintel.CategoryRef `json:"category"`
	ActionType    string                `json:"action_type"`
	Confidence    float64               `json:"confidence"`
	Method        string                `json:"method"`
	Status        string                `json:"status"`
	WorkTitle     string                `json:"work_title"`
	Tags          []string              `json:"tags"`
	Technologies  []string              `json:"technologies"`
	Tokens        int64                 `json:"tokens"`
	CostKRW       float64               `json:"cost_krw"`
	LatencyMS     int64                 `json:"latency_ms"`
	IsError       bool                  `json:"is_error"`
	PolicyVersion int                   `json:"policy_version"`
}

// requestView presents a fact. A category that was merged or disabled since
// is shown as the category that stands for it now.
//
// The work title, the tags and the technologies summarise what the prompt
// said: the rules take them from it and a model writes them after reading it.
// A caller who may not see raw prompts gets none of them.
func (q *workIntelReadQuery) requestView(fact store.WorkClassification) workRequestView {
	tags, technologies, title := fact.Tags, fact.Technologies, fact.WorkTitle
	if !q.caller.privileged {
		tags, technologies, title = nil, nil, ""
	}
	if tags == nil {
		tags = []string{}
	}
	if technologies == nil {
		technologies = []string{}
	}
	return workRequestView{
		RequestID: fact.RequestID, CreatedAt: fact.CreatedAt, SessionID: fact.SessionID, Team: fact.Team,
		User: q.s.workIntelUserLabel(q.caller, fact.UserKey), Client: fact.Client, Model: fact.Model,
		Category: q.engine.Ref(q.engine.Canonical(fact.CategoryID)), ActionType: fact.ActionType, Confidence: fact.Confidence,
		Method: fact.Method, Status: fact.Status, WorkTitle: title, Tags: tags, Technologies: technologies,
		Tokens: fact.TokensIn + fact.TokensOut, CostKRW: workIntelRound(fact.CostKRW), LatencyMS: fact.LatencyMS,
		IsError: fact.IsError, PolicyVersion: fact.PolicyVersion,
	}
}

type workRequestsResponse struct {
	Scope  workIntelScope    `json:"scope"`
	Rows   []workRequestView `json:"rows"`
	Count  int64             `json:"count"`
	Limit  int               `json:"limit"`
	Offset int               `json:"offset"`
}

func (s *Server) workIntelRequests(ctx context.Context, q *workIntelReadQuery, limit, offset int) (workRequestsResponse, error) {
	out := workRequestsResponse{Scope: q.scope, Rows: []workRequestView{}, Limit: limit, Offset: offset}
	f, err := q.filter(ctx, q.from, q.to)
	if err != nil {
		return out, err
	}
	facts, count, err := s.db.ListWorkFacts(ctx, store.WorkFactQuery{Filter: f, Limit: limit, Offset: offset})
	if err != nil {
		return out, err
	}
	out.Count = count
	for _, fact := range facts {
		out.Rows = append(out.Rows, q.requestView(fact))
	}
	return out, nil
}

func (s *Server) handleWorkIntelRequests(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	out, err := s.workIntelRequests(r.Context(), q, q.limit, q.offset)
	if err != nil {
		workIntelFailed(w, r, "the request list", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Review queue ----

var workIntelReviewStatuses = []string{workintel.StatusReview, workintel.StatusUnclassified, workintel.StatusFailed}

type workReviewSummary struct {
	Review           int64                 `json:"review"`
	Unclassified     int64                 `json:"unclassified"`
	Failed           int64                 `json:"failed"`
	NewCategoryHints []store.WorkHintCount `json:"new_category_hints"`
}

type workReviewResponse struct {
	Rows    []workRequestView `json:"rows"`
	Count   int64             `json:"count"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
	Summary workReviewSummary `json:"summary"`
}

// handleWorkIntelReview lists the requests that need a decision. It belongs to
// the classification console, so it also works while analytics is off. Without
// from/to it covers the last 30 days: the prompt a reviewer would have to read
// is not kept longer than that by default.
func (s *Server) handleWorkIntelReview(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	ctx := r.Context()
	f, err := q.filter(ctx, q.from, q.to)
	if err != nil {
		workIntelFailed(w, r, "the review queue", err)
		return
	}
	// The summary counts the whole queue, whatever tab is open.
	queue := f
	queue.Statuses, queue.MinConfidence, queue.MaxConfidence = workIntelReviewStatuses, nil, nil
	if len(f.Statuses) == 0 {
		f.Statuses = workIntelReviewStatuses
	} else if !workIntelHasStatus(workIntelReviewStatuses, f.Statuses[0]) {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", "status must be one of review, unclassified, failed")
		return
	}
	out := workReviewResponse{Rows: []workRequestView{}, Limit: q.limit, Offset: q.offset}
	facts, count, err := s.db.ListWorkFacts(ctx, store.WorkFactQuery{Filter: f, Limit: q.limit, Offset: q.offset})
	if err != nil {
		workIntelFailed(w, r, "the review queue", err)
		return
	}
	out.Count = count
	for _, fact := range facts {
		out.Rows = append(out.Rows, q.requestView(fact))
	}
	summary, err := s.db.WorkFactSummary(ctx, queue)
	if err != nil {
		workIntelFailed(w, r, "the review queue", err)
		return
	}
	out.Summary = workReviewSummary{Review: summary.ByStatus[workintel.StatusReview], Unclassified: summary.ByStatus[workintel.StatusUnclassified],
		Failed: summary.ByStatus[workintel.StatusFailed]}
	// A hint is a category name a model proposed after reading the prompt.
	out.Summary.NewCategoryHints = []store.WorkHintCount{}
	if q.caller.privileged {
		if out.Summary.NewCategoryHints, err = s.db.WorkCategoryHints(ctx, queue, 20); err != nil {
			workIntelFailed(w, r, "the review queue", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Sessions ----

type workSessionView struct {
	SessionID     string                  `json:"session_id"`
	SessionKind   string                  `json:"session_kind"`
	Team          string                  `json:"team"`
	User          string                  `json:"user"`
	Client        string                  `json:"client"`
	Primary       workintel.CategoryRef   `json:"primary"`
	Secondary     []workintel.CategoryRef `json:"secondary"`
	FirstAt       string                  `json:"first_at"`
	LastAt        string                  `json:"last_at"`
	Requests      int64                   `json:"requests"`
	MCPCalls      int64                   `json:"mcp_calls"`
	TokensIn      int64                   `json:"tokens_in"`
	TokensOut     int64                   `json:"tokens_out"`
	CostKRW       float64                 `json:"cost_krw"`
	DurationMS    int64                   `json:"duration_ms"`
	ModelTimeMS   int64                   `json:"model_time_ms"`
	Errors        int64                   `json:"errors"`
	Retries       int64                   `json:"retries"`
	Models        []string                `json:"models"`
	ModelSwitches int64                   `json:"model_switches"`
	PolicyFlags   []string                `json:"policy_flags"`
	Completion    string                  `json:"completion"`
}

// workIntelMaxSecondary bounds the secondary categories listed for a session.
const workIntelMaxSecondary = 5

func workIntelDuration(firstAt, lastAt string) int64 {
	first, err1 := time.Parse(time.RFC3339Nano, firstAt)
	last, err2 := time.Parse(time.RFC3339Nano, lastAt)
	if err1 != nil || err2 != nil || last.Before(first) {
		return 0
	}
	return last.Sub(first).Milliseconds()
}

// sessionView presents a session head. Its categories are folded to the ones
// that stand for them now; the primary is where most of its requests went.
func (q *workIntelReadQuery) sessionView(row store.WorkSessionRow) workSessionView {
	counts := map[string]int64{}
	for id, n := range row.CategoryCounts {
		counts[q.engine.Canonical(id)] += n
	}
	categories := make([]string, 0, len(counts))
	for id := range counts {
		categories = append(categories, id)
	}
	sort.Slice(categories, func(i, j int) bool {
		if counts[categories[i]] != counts[categories[j]] {
			return counts[categories[i]] > counts[categories[j]]
		}
		return categories[i] < categories[j]
	})
	view := workSessionView{
		SessionID: row.SessionID, SessionKind: row.Kind, Team: row.Team, User: q.s.workIntelUserLabel(q.caller, row.UserKey),
		Client: row.Client, Secondary: []workintel.CategoryRef{}, FirstAt: row.FirstAt, LastAt: row.LastAt,
		Requests: row.Requests, MCPCalls: row.MCPCalls, TokensIn: row.TokensIn, TokensOut: row.TokensOut,
		CostKRW: workIntelRound(row.CostKRW), DurationMS: workIntelDuration(row.FirstAt, row.LastAt), ModelTimeMS: row.LatencyMS,
		Errors: row.Errors, Retries: row.Retries, Models: row.Models, ModelSwitches: row.ModelSwitches,
		PolicyFlags: row.PolicyFlags, Completion: row.Completion,
	}
	if view.Models == nil {
		view.Models = []string{}
	}
	if view.PolicyFlags == nil {
		view.PolicyFlags = []string{}
	}
	if len(categories) == 0 {
		categories = []string{q.engine.Canonical(row.PrimaryCategoryID)}
	}
	view.Primary = q.engine.Ref(categories[0])
	for _, id := range categories[1:] {
		if len(view.Secondary) >= workIntelMaxSecondary {
			break
		}
		view.Secondary = append(view.Secondary, q.engine.Ref(id))
	}
	return view
}

type workSessionsResponse struct {
	Scope  workIntelScope    `json:"scope"`
	Rows   []workSessionView `json:"rows"`
	Count  int64             `json:"count"`
	Limit  int               `json:"limit"`
	Offset int               `json:"offset"`
}

var workIntelSessionSorts = map[string]bool{"last_at": true, "requests": true, "cost_krw": true, "duration_ms": true, "errors": true}

var workIntelSessionStates = []string{store.WorkCompletionUnknown, store.WorkCompletionError, store.WorkCompletionConfirmed}

// workIntelSessionSort reads sort=<field>:<asc|desc>. The default is the most
// recently active session first.
func workIntelSessionSort(r *http.Request) (field string, desc bool, err error) {
	raw, err := workIntelText(r, "sort", 64)
	if err != nil {
		return "", false, err
	}
	if raw == "" {
		return "last_at", true, nil
	}
	field, direction, found := strings.Cut(raw, ":")
	if !workIntelSessionSorts[field] || (found && direction != "asc" && direction != "desc") {
		return "", false, workIntelBadQuery{"sort must be <field>:<asc|desc> with field one of last_at, requests, cost_krw, duration_ms, errors"}
	}
	return field, !found || direction == "desc", nil
}

type workSessionListOptions struct {
	sortBy     string
	desc       bool
	completion string
}

func workIntelSessionOptions(r *http.Request) (workSessionListOptions, error) {
	var opts workSessionListOptions
	var err error
	if opts.sortBy, opts.desc, err = workIntelSessionSort(r); err != nil {
		return opts, err
	}
	opts.completion, err = workIntelOneOf(r, "session_status", workIntelSessionStates, 32)
	return opts, err
}

func (s *Server) workIntelSessions(ctx context.Context, q *workIntelReadQuery, opts workSessionListOptions, limit, offset int) (workSessionsResponse, error) {
	out := workSessionsResponse{Scope: q.scope, Rows: []workSessionView{}, Limit: limit, Offset: offset}
	f, err := q.filter(ctx, q.from, q.to)
	if err != nil {
		return out, err
	}
	rows, count, err := s.db.ListWorkSessions(ctx, store.WorkSessionQuery{Filter: f, Completion: opts.completion,
		SortBy: opts.sortBy, Desc: opts.desc, Limit: limit, Offset: offset})
	if err != nil {
		return out, err
	}
	out.Count = count
	for _, row := range rows {
		out.Rows = append(out.Rows, q.sessionView(row))
	}
	return out, nil
}

func (s *Server) handleWorkIntelSessions(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	opts, err := workIntelSessionOptions(r)
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	out, err := s.workIntelSessions(r.Context(), q, opts, q.limit, q.offset)
	if err != nil {
		workIntelFailed(w, r, "the session list", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type workSessionSegmentView struct {
	Category workintel.CategoryRef `json:"category"`
	Requests int64                 `json:"requests"`
	CostKRW  float64               `json:"cost_krw"`
	FirstAt  string                `json:"first_at"`
	LastAt   string                `json:"last_at"`
}

type workSessionDetailResponse struct {
	Session  workSessionView          `json:"session"`
	Segments []workSessionSegmentView `json:"segments"`
	Requests []workRequestView        `json:"requests"`
}

// workIntelSessionRequests is how many requests a session detail carries.
const workIntelSessionRequests = 200

// handleWorkIntelSession returns one session. A session id is chosen by the
// client, so two teams can use the same one: ?team= picks between them, and
// without it the most recently active is returned. A session of a team the
// caller may not see does not exist for them.
func (s *Server) handleWorkIntelSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	q, ok := s.workIntelPresenter(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	team, err := workIntelText(r, "team", 128)
	if err != nil || len(sessionID) > 512 {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", "the session id or team is not valid")
		return
	}
	heads, err := s.db.WorkSessionHeads(ctx, sessionID, q.caller.teams, q.caller.scoped)
	if err != nil {
		workIntelFailed(w, r, "the session", err)
		return
	}
	var head *store.WorkSessionRow
	for i := range heads {
		if team == "" || heads[i].Team == team {
			head = &heads[i]
			break
		}
	}
	if head == nil {
		workIntelError(w, http.StatusNotFound, "work_session_not_found", "no such work session")
		return
	}
	out := workSessionDetailResponse{Session: q.sessionView(*head), Segments: []workSessionSegmentView{}, Requests: []workRequestView{}}
	segments, err := s.db.WorkSessionSegments(ctx, head.SessionID, head.Team)
	if err != nil {
		workIntelFailed(w, r, "the session", err)
		return
	}
	// A segment is stored per day; the detail shows one per kind of work.
	position := map[string]int{}
	for _, segment := range segments {
		category := q.engine.Canonical(segment.CategoryID)
		i, seen := position[category]
		if !seen {
			position[category] = len(out.Segments)
			out.Segments = append(out.Segments, workSessionSegmentView{Category: q.engine.Ref(category), FirstAt: segment.FirstAt, LastAt: segment.LastAt})
			i = len(out.Segments) - 1
		}
		view := &out.Segments[i]
		view.Requests += segment.Requests
		view.CostKRW = workIntelRound(view.CostKRW + segment.CostKRW)
		if segment.FirstAt < view.FirstAt {
			view.FirstAt = segment.FirstAt
		}
		if segment.LastAt > view.LastAt {
			view.LastAt = segment.LastAt
		}
	}
	facts, err := s.db.WorkSessionFacts(ctx, head.SessionID, head.Team, workIntelSessionRequests)
	if err != nil {
		workIntelFailed(w, r, "the session", err)
		return
	}
	for _, fact := range facts {
		out.Requests = append(out.Requests, q.requestView(fact))
	}
	writeJSON(w, http.StatusOK, out)
}
