package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// Reclassification: classifying requests that already have a classification
// again, with the policy that is published now.
//
// It follows the reviewed-job pattern of clickhouse_retry_review.go. A GET
// previews what would be touched and returns a revision: a keyed digest of the
// caller, the selection, the reviewed instant and the published policy
// version, with the selection itself (and what the preview counted) in front
// of it. The POST presents that revision and nothing else. The job starts if
// the signature holds for the same caller and policy and the preview is not
// older than five minutes. The selection is counted again at that point; the
// count is not part of the signature, because the worker keeps classifying
// (and retrying the model on) requests of the selection between the preview
// and the confirmation, which is normal work and not a reason to refuse.
// What changed shows in the job as previewed against total. One job runs at a
// time; its owner renews a lease, so a job whose process died reads as
// interrupted instead of running forever.
//
// Three kinds of rows are never made worse by a job:
//
//   - a manual correction is kept as it is;
//   - a request whose prompt text is no longer stored (prompts are purged
//     earlier than requests) keeps its classification, because without the text
//     the rules would return "unclassified" for almost everything; only a row
//     that already is unclassified or failed is tried again on its metadata;
//   - a result the classification model gave is kept when the rules cannot
//     settle the request and the model cannot be asked now.

const (
	workIntelReclassifyTTL      = 5 * time.Minute
	workIntelReclassifyKind     = "reclassify"
	workIntelReclassifyChunk    = 200
	workIntelReclassifyDeadline = 4 * time.Hour
	workIntelReclassifyBeat     = 15 * time.Second
	workIntelReclassifyLayout   = "2006-01-02T15:04:05.000000000Z"
)

// workIntelReclassifyPause is the wait between two chunks of a job. A job is
// maintenance: the pause leaves the database and the worker room to do their
// regular work in between. A variable so tests can shorten it.
var workIntelReclassifyPause = 100 * time.Millisecond

// workReclassifyParams is the selection of a job, stored with it.
type workReclassifyParams struct {
	From          string   `json:"from"`
	To            string   `json:"to"`
	Status        string   `json:"status"`
	Method        string   `json:"method"`
	Category      string   `json:"category"`
	Categories    []string `json:"categories"`
	Teams         []string `json:"teams"`
	TeamScoped    bool     `json:"team_scoped"`
	ReviewedAt    string   `json:"reviewed_at"`
	PolicyVersion int      `json:"policy_version"`
	Reason        string   `json:"reason"`
	AuditAdmin    string   `json:"audit_admin"`
}

// filter selects the facts of the job. UpdatedThrough pins the selection to
// the moment of the review: requests classified after it are not part of what
// was reviewed, and a fact the job has rewritten drops out by itself.
func (p workReclassifyParams) filter() store.WorkFilter {
	f := store.WorkFilter{From: p.From, To: p.To, Teams: p.Teams, TeamScoped: p.TeamScoped, Method: p.Method,
		Categories: p.Categories, UpdatedThrough: p.ReviewedAt}
	if p.Status != "" {
		f.Statuses = []string{p.Status}
	}
	return f
}

type workJobProgressView struct {
	Total       int64  `json:"total"`
	Done        int64  `json:"done"`
	Changed     int64  `json:"changed"`
	Failed      int64  `json:"failed"`
	DaysRebuilt int    `json:"days_rebuilt"`
	Cursor      string `json:"cursor"`
	KeptNoText  int64  `json:"kept_no_text"`
	Previewed   int64  `json:"previewed"`
}

type workJobView struct {
	ID        string              `json:"id"`
	Status    string              `json:"status"`
	Actor     string              `json:"actor"`
	CreatedAt string              `json:"created_at"`
	UpdatedAt string              `json:"updated_at"`
	Error     string              `json:"error,omitempty"`
	Progress  workJobProgressView `json:"progress"`
}

func workIntelJobView(job store.WorkIntelJob) workJobView {
	return workJobView{ID: job.ID, Status: job.Status, Actor: job.Actor, CreatedAt: job.CreatedAt, UpdatedAt: job.UpdatedAt, Error: job.Error,
		Progress: workJobProgressView{Total: job.Progress.Total, Done: job.Progress.Done, Changed: job.Progress.Changed, Failed: job.Progress.Failed,
			DaysRebuilt: job.Progress.DaysRebuilt, Cursor: job.Progress.Cursor, KeptNoText: job.Progress.KeptNoText,
			Previewed: job.Progress.Previewed}}
}

// mayReadJob: a job is its actor's, and a full administrator may look at any.
func (c workIntelCaller) mayReadJob(job store.WorkIntelJob) bool {
	return job.Actor == c.actor || c.privileged
}

// workIntelActiveJobView reports the running job to a preview. A caller who
// may not read it still learns that one is running, because that is why they
// cannot start their own; they learn nothing else about it.
func (c workIntelCaller) activeJobView(job store.WorkIntelJob) *workJobView {
	view := workIntelJobView(job)
	if !c.mayReadJob(job) {
		view = workJobView{Status: job.Status}
	}
	return &view
}

type workReclassifyPreview struct {
	Revision    string           `json:"revision"`
	ReviewedAt  string           `json:"reviewed_at"`
	ExpiresAt   string           `json:"expires_at"`
	Total       int64            `json:"total"`
	ByStatus    map[string]int64 `json:"by_status"`
	ByMethod    map[string]int64 `json:"by_method"`
	ManualKept  int64            `json:"manual_kept"`
	EstLLMCalls int64            `json:"est_llm_calls"`
	Days        int              `json:"days"`
	ActiveJob   *workJobView     `json:"active_job"`
	// NoTextKept is how many of the selected requests have no stored prompt
	// text any more and therefore keep the classification they have. Only the
	// first store.WorkTextProbeCap requests are looked up; NoTextCapped says the
	// selection was larger and the count is a lower bound.
	NoTextKept   int64 `json:"no_text_kept"`
	NoTextCapped bool  `json:"no_text_capped"`
}

type workReclassifyPlan struct {
	preview workReclassifyPreview
	params  workReclassifyParams
	jobID   string
}

// workReclassifySelection is what the administrator selected. It travels
// inside the revision, because the confirmation carries nothing else: the
// revision is "<selection>.<signature>", so any instance can recount exactly
// what was previewed without having kept the preview.
type workReclassifySelection struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Status   string `json:"status,omitempty"`
	Method   string `json:"method,omitempty"`
	Category string `json:"category,omitempty"`
	// Previewed is how many requests the preview counted. It is signed with the
	// rest, so the job can report it next to its own count.
	Previewed int64 `json:"previewed,omitempty"`
}

func (sel workReclassifySelection) valid() bool {
	from, okFrom := workIntelParseDay(sel.From)
	to, okTo := workIntelParseDay(sel.To)
	return okFrom && okTo && !from.After(to) && workIntelDaysBetween(from, to) <= workIntelMaxDays &&
		(sel.Status == "" || workIntelHasStatus(workIntelStatuses, sel.Status)) &&
		(sel.Method == "" || workIntelHasStatus(workIntelMethods, sel.Method)) &&
		len(sel.Category) <= 128 && !strings.ContainsAny(sel.Category, "\x00\r\n") && sel.Previewed >= 0
}

func workIntelReclassifySelectionOf(r *http.Request) (workReclassifySelection, error) {
	var sel workReclassifySelection
	from, to, err := workIntelPeriod(r, workIntelDefaultDays, workIntelMaxDays)
	if err != nil {
		return sel, err
	}
	sel.From, sel.To = workIntelFormatDay(from), workIntelFormatDay(to)
	if sel.Status, err = workIntelOneOf(r, "status", workIntelStatuses, 32); err != nil {
		return sel, err
	}
	if sel.Method, err = workIntelOneOf(r, "method", workIntelMethods, 32); err != nil {
		return sel, err
	}
	sel.Category, err = workIntelText(r, "category", 128)
	return sel, err
}

// workIntelRevisionSelection reads the selection and the signature out of a
// revision. Nothing is trusted yet: the signature is checked by recounting.
func workIntelRevisionSelection(revision string) (sel workReclassifySelection, signature string, ok bool) {
	encoded, signature, found := strings.Cut(revision, ".")
	if !found || len(encoded) > 1024 || len(signature) != 64 || signature != strings.ToLower(signature) {
		return sel, "", false
	}
	if _, err := hex.DecodeString(signature); err != nil {
		return sel, "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || json.Unmarshal(raw, &sel) != nil || !sel.valid() {
		return sel, "", false
	}
	return sel, signature, true
}

// workIntelReclassifyPlan counts the selection as of the instant at and signs
// it. The same call serves the preview and, with the reviewed instant and the
// selection read back from the revision, the confirmation: preview says which,
// because only the preview records its count in the selection.
func (s *Server) workIntelReclassifyPlan(ctx context.Context, caller workIntelCaller, sel workReclassifySelection, at time.Time, preview bool) (workReclassifyPlan, error) {
	var plan workReclassifyPlan
	params := workReclassifyParams{From: sel.From, To: sel.To, Status: sel.Status, Method: sel.Method, Teams: caller.teams, TeamScoped: caller.scoped,
		ReviewedAt: at.UTC().Format(workIntelReclassifyLayout)}
	q, err := s.workIntelPresenterFor(ctx, caller)
	if err != nil {
		return plan, fmt.Errorf("load work policy: %w", err)
	}
	params.PolicyVersion = q.version
	if sel.Category != "" {
		q.setCategory(sel.Category)
		params.Category = q.category
		selected, err := q.filter(ctx, params.From, params.To)
		if err != nil {
			return plan, err
		}
		params.Categories = selected.Categories
	}
	filter := params.filter()
	summary, err := s.db.WorkFactSummary(ctx, filter)
	if err != nil {
		return plan, err
	}
	// Only the preview shows how many requests keep their classification for
	// want of text; the lookup is bounded and is not repeated at confirmation.
	var noText int64
	var noTextCapped bool
	if preview {
		if noText, noTextCapped, err = s.db.WorkFactsWithoutText(ctx, filter, workintel.MethodManual,
			[]string{workintel.StatusUnclassified, workintel.StatusFailed}, 0); err != nil {
			return plan, err
		}
	}
	manual := summary.ByMethod[workintel.MethodManual]
	conf := s.workIntelConf()
	var estimate int64
	if conf.LLMEnabled {
		if _, block := s.workIntelLLMTargetFor(ctx, conf); block == nil {
			// What the rules could not settle before is what they will hand to the
			// model again: the rows a model or the cache answered, and those waiting.
			estimate = summary.ByMethod[workintel.MethodLLM] + summary.ByMethod[workintel.MethodCache] + summary.NeedsLLM
			if rest := summary.Total - manual - noText; estimate > rest {
				estimate = rest
			}
			if estimate < 0 {
				estimate = 0
			}
		}
	}
	plan.params = params
	plan.preview = workReclassifyPreview{
		ReviewedAt: params.ReviewedAt, ExpiresAt: at.Add(workIntelReclassifyTTL).UTC().Format(workIntelReclassifyLayout),
		Total: summary.Total, ByStatus: summary.ByStatus, ByMethod: summary.ByMethod, ManualKept: manual, NoTextKept: noText,
		NoTextCapped: noTextCapped, EstLLMCalls: estimate, Days: len(summary.Days),
	}
	if preview {
		sel.Previewed = summary.Total
	}
	// Only what the administrator decided is signed: who, which selection, as
	// of when, under which policy, and for which teams. The counts are not:
	// they move with the worker's normal work (see the file comment).
	signed, err := json.Marshal(struct {
		Version       string
		Actor         string
		Selection     workReclassifySelection
		ReviewedAt    string
		PolicyVersion int
		Teams         []string
		TeamScoped    bool
	}{"work-reclassify-v2", caller.actor, sel, params.ReviewedAt, params.PolicyVersion, params.Teams, params.TeamScoped})
	if err != nil {
		return plan, err
	}
	key := s.cfg.Auth.JWTSecret
	if key == "" {
		key = s.cfg.Secret.GatewaySecret
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("work-reclassify-review-v1\x00"))
	mac.Write(signed)
	signature := hex.EncodeToString(mac.Sum(nil))
	selection, err := json.Marshal(sel)
	if err != nil {
		return plan, err
	}
	plan.preview.Revision = base64.RawURLEncoding.EncodeToString(selection) + "." + signature
	plan.jobID = "wir_" + signature[:40]
	return plan, nil
}

func workIntelPlanFailed(w http.ResponseWriter, r *http.Request, err error) {
	var bad workIntelBadQuery
	if errors.As(err, &bad) {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", bad.message)
		return
	}
	workIntelFailed(w, r, "counting the requests to reclassify", err)
}

func (s *Server) handleWorkIntelReclassifyPreview(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return
	}
	sel, err := workIntelReclassifySelectionOf(r)
	if err != nil {
		workIntelPlanFailed(w, r, err)
		return
	}
	plan, err := s.workIntelReclassifyPlan(r.Context(), caller, sel, time.Now(), true)
	if err != nil {
		workIntelPlanFailed(w, r, err)
		return
	}
	active, found, err := s.db.ActiveWorkIntelJob(r.Context())
	if err != nil {
		workIntelFailed(w, r, "reading the active job", err)
		return
	}
	if found {
		plan.preview.ActiveJob = caller.activeJobView(active)
	}
	writeJSON(w, http.StatusOK, plan.preview)
}

func (s *Server) handleWorkIntelReclassifyStart(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return
	}
	// A job classifies, so it does not run while classification is switched off.
	if !s.workIntelConf().ClassifyEnabled {
		workIntelError(w, http.StatusServiceUnavailable, "work_intel_classify_disabled",
			"work classification is switched off (work_intel.classify_enabled)")
		return
	}
	if r.URL.Query().Get("reviewed") != "1" {
		workIntelError(w, http.StatusBadRequest, "work_reclassify_review_required", "preview the reclassification first and confirm it with reviewed=1")
		return
	}
	var payload struct {
		Revision   string `json:"revision"`
		ReviewedAt string `json:"reviewed_at"`
		Reason     string `json:"reason"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	reason, fits := workIntelClip(payload.Reason, 1000)
	sel, signature, valid := workIntelRevisionSelection(payload.Revision)
	if !valid || reason == "" || !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "revision must come from the preview and reason hold 1 to 1,000 characters")
		return
	}
	ctx := r.Context()
	jobID := "wir_" + signature[:40]
	// A repeated confirmation of the same preview returns the job it started.
	if existing, found, err := s.db.GetWorkIntelJob(ctx, jobID); err != nil {
		workIntelFailed(w, r, "reading the job", err)
		return
	} else if found {
		if !caller.mayReadJob(existing) {
			workIntelError(w, http.StatusForbidden, "work_job_denied", "this job belongs to another administrator")
			return
		}
		writeJSON(w, http.StatusOK, workIntelJobView(existing))
		return
	}
	at, err := time.Parse(workIntelReclassifyLayout, payload.ReviewedAt)
	if age := time.Since(at); err != nil || at.UTC().Format(workIntelReclassifyLayout) != payload.ReviewedAt || age < 0 || age > workIntelReclassifyTTL {
		workIntelError(w, http.StatusConflict, "work_reclassify_expired", "the preview has expired; preview the reclassification again")
		return
	}
	// Counted again with the selection the revision names, as of the reviewed
	// instant. A different policy, caller, instant or selection gives a
	// different signature; a different count does not.
	plan, err := s.workIntelReclassifyPlan(ctx, caller, sel, at, false)
	if err != nil {
		workIntelPlanFailed(w, r, err)
		return
	}
	if !hmac.Equal([]byte(plan.preview.Revision), []byte(payload.Revision)) {
		workIntelError(w, http.StatusConflict, "work_reclassify_conflict",
			"the published policy changed since the preview, or the preview belongs to another selection or administrator; preview again")
		return
	}
	if plan.preview.Total == 0 {
		workIntelError(w, http.StatusConflict, "work_reclassify_empty", "no request matches the selection")
		return
	}
	plan.params.Reason, plan.params.AuditAdmin = reason, adminID(r)
	encoded, err := json.Marshal(plan.params)
	if err != nil {
		workIntelFailed(w, r, "encoding the job", err)
		return
	}
	job := store.WorkIntelJob{ID: plan.jobID, Kind: workIntelReclassifyKind, Actor: caller.actor, WorkerToken: newID("wijob"),
		ParamsJSON: string(encoded), Progress: store.WorkIntelJobProgress{Total: plan.preview.Total, Previewed: sel.Previewed}}
	admitted, err := s.db.AdmitWorkIntelJob(ctx, job, store.AdminAuditLog{
		ID: job.ID + "_requested", AdminID: plan.params.AuditAdmin, Action: "work_intel.reclassify.requested", BeforeValue: job.ID,
		AfterValue: auditJSON(map[string]any{"job_id": job.ID, "reason": reason, "from": plan.params.From, "to": plan.params.To,
			"status": plan.params.Status, "method": plan.params.Method, "category": plan.params.Category, "team_scoped": plan.params.TeamScoped,
			"total": plan.preview.Total, "previewed": sel.Previewed, "manual_kept": plan.preview.ManualKept,
			"policy_version": plan.params.PolicyVersion}),
	})
	if errors.Is(err, store.ErrWorkIntelJobActive) {
		body := map[string]any{"error": map[string]any{"message": "another work intelligence job is running; wait for it to finish and preview again",
			"type": "invalid_request_error", "param": nil, "code": "work_job_active"}, "active_job": nil}
		if active, found, activeErr := s.db.ActiveWorkIntelJob(ctx); activeErr == nil && found {
			body["active_job"] = caller.activeJobView(active)
		}
		writeJSON(w, http.StatusConflict, body)
		return
	}
	if err != nil {
		workIntelFailed(w, r, "admitting the job", err)
		return
	}
	stored, found, err := s.db.GetWorkIntelJob(ctx, job.ID)
	if err != nil || !found {
		if err == nil {
			err = errors.New("the admitted job cannot be read")
		}
		workIntelFailed(w, r, "reading the job", err)
		return
	}
	if !admitted {
		// Another confirmation of the same preview got there first.
		writeJSON(w, http.StatusOK, workIntelJobView(stored))
		return
	}
	go s.runWorkIntelReclassify(job, plan.params)
	writeJSON(w, http.StatusAccepted, workIntelJobView(stored))
}

func (s *Server) handleWorkIntelReclassifyJob(w http.ResponseWriter, r *http.Request, id string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return
	}
	if len(id) > 128 || !strings.HasPrefix(id, "wir_") {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", "the job id is not valid")
		return
	}
	job, found, err := s.db.GetWorkIntelJob(r.Context(), id)
	if err != nil {
		workIntelFailed(w, r, "reading the job", err)
		return
	}
	if !found {
		workIntelError(w, http.StatusNotFound, "work_job_not_found", "no such job")
		return
	}
	if !caller.mayReadJob(job) {
		workIntelError(w, http.StatusForbidden, "work_job_denied", "this job belongs to another administrator")
		return
	}
	writeJSON(w, http.StatusOK, workIntelJobView(job))
}

// runWorkIntelReclassify runs an admitted job to its end. It outlives the
// request that started it and is bounded by the server's lifetime and a
// deadline. A job that loses its lease stops; nothing restarts it.
func (s *Server) runWorkIntelReclassify(job store.WorkIntelJob, params workReclassifyParams) {
	ctx, cancel := context.WithTimeout(s.db.LifecycleContext(), workIntelReclassifyDeadline)
	defer cancel()
	beatDone := make(chan struct{})
	go func() {
		defer close(beatDone)
		ticker := time.NewTicker(workIntelReclassifyBeat)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				beatCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				err := s.db.UpdateWorkIntelJob(beatCtx, job.ID, job.WorkerToken, nil)
				stop()
				if errors.Is(err, store.ErrWorkIntelJobConflict) {
					cancel()
					return
				}
			}
		}
	}()
	progress := job.Progress
	runErr := func() (err error) {
		// A bug in the classifier costs the job, not the gateway.
		defer func() {
			if p := recover(); p != nil {
				slog.Error("work intel: reclassification job panicked", "job", job.ID, "panic", p)
				err = errors.New("the job stopped on an internal error")
			}
		}()
		return s.workIntelReclassify(ctx, job, params, &progress)
	}()
	cancel()
	<-beatDone

	status, errText := store.WorkJobSucceeded, ""
	if runErr != nil {
		status, errText = store.WorkJobFailed, boundedWorkIntelError(runErr)
		slog.Warn("work intel: reclassification job failed", "job", job.ID, "error", errText)
	}
	finishCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := s.db.FinishWorkIntelJob(finishCtx, job.ID, job.WorkerToken, status, progress, errText); err != nil {
		// The job reads as interrupted once its lease runs out; no success is invented.
		slog.Warn("work intel: recording the end of the reclassification job failed", "job", job.ID, "error", err)
		return
	}
	if err := s.db.InsertAdminAudit(finishCtx, store.AdminAuditLog{ID: job.ID + "_completed", AdminID: params.AuditAdmin,
		Action: "work_intel.reclassify.completed", BeforeValue: job.ID,
		AfterValue: auditJSON(map[string]any{"job_id": job.ID, "status": status, "reason": params.Reason, "progress": progress})}); err != nil {
		slog.Warn("work intel: writing the reclassification audit failed", "job", job.ID, "error", err)
	}
}

// workIntelJobWorker returns the worker whose model budget a job uses: the
// one this instance runs, so the job and the regular classification stay
// within one per-minute limit, or a private one where no worker was started.
func (s *Server) workIntelJobWorker() *WorkIntelWorker {
	if live := s.workIntel.worker.Load(); live != nil {
		return live
	}
	return &WorkIntelWorker{server: s, token: s.instanceID + "/" + newID("wijob"), done: make(chan struct{}),
		retryBackoff: workIntelRetryBackoff, breakerAfter: workIntelLLMBreakerFailures}
}

// workIntelReclassify walks the selection day by day in chunks ordered by
// (created_at, request_id), classifies each chunk with the published policy,
// and rebuilds the aggregates of a day when the day is done.
func (s *Server) workIntelReclassify(ctx context.Context, job store.WorkIntelJob, params workReclassifyParams, progress *store.WorkIntelJobProgress) error {
	snap, err := s.workIntelActiveEngine(ctx, 0)
	if err != nil {
		return fmt.Errorf("load work policy: %w", err)
	}
	filter := params.filter()
	summary, err := s.db.WorkFactSummary(ctx, filter)
	if err != nil {
		return fmt.Errorf("count the selection: %w", err)
	}
	worker := s.workIntelJobWorker()
	save := func() error {
		saveCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		return s.db.UpdateWorkIntelJob(saveCtx, job.ID, job.WorkerToken, progress)
	}
	for _, day := range summary.Days {
		afterAt, afterID := "", ""
		stale := false
		sessions := []string{}
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			facts, err := s.db.WorkFactPage(ctx, filter, day, afterAt, afterID, workIntelReclassifyChunk)
			if err != nil {
				return fmt.Errorf("read a chunk: %w", err)
			}
			if len(facts) == 0 {
				break
			}
			result, err := s.workIntelReclassifyChunk(ctx, worker, snap, facts, progress)
			if err != nil {
				return err
			}
			if len(result.Days) > 0 {
				stale = true
			}
			sessions = append(sessions, result.SessionIDs...)
			last := facts[len(facts)-1]
			afterAt, afterID = last.CreatedAt, last.RequestID
			progress.Done += int64(len(facts))
			progress.Cursor = day + "|" + afterAt + "|" + afterID
			if err := save(); err != nil {
				return fmt.Errorf("save progress: %w", err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(workIntelReclassifyPause):
			}
		}
		// The changed facts already marked the day stale, so if this rebuild is
		// lost the worker's next pass does it.
		if stale {
			rebuilt, err := s.db.RebuildWorkDays(ctx, []string{day})
			if err != nil {
				return fmt.Errorf("rebuild the day: %w", err)
			}
			progress.DaysRebuilt += len(rebuilt.Days)
		}
		if len(sessions) > 0 {
			if _, err := s.db.RebuildWorkSessions(ctx, sessions); err != nil {
				return fmt.Errorf("rebuild the sessions: %w", err)
			}
		}
		if err := save(); err != nil {
			return fmt.Errorf("save progress: %w", err)
		}
	}
	return nil
}

// workIntelReclassifyChunk classifies one chunk and stores what changed.
func (s *Server) workIntelReclassifyChunk(ctx context.Context, worker *WorkIntelWorker, snap *workIntelEngineSnapshot,
	facts []store.WorkClassification, progress *store.WorkIntelJobProgress) (store.WorkReassignResult, error) {
	ids := make([]string, 0, len(facts))
	current := make(map[string]store.WorkClassification, len(facts))
	for _, fact := range facts {
		if fact.Method == workintel.MethodManual {
			continue
		}
		ids = append(ids, fact.RequestID)
		current[fact.RequestID] = fact
	}
	if len(ids) == 0 {
		return store.WorkReassignResult{}, nil
	}
	requests, err := s.db.WorkIntelRequests(ctx, ids, snap.maxInputChars)
	if err != nil {
		return store.WorkReassignResult{}, fmt.Errorf("read the requests of a chunk: %w", err)
	}
	var withText, metadataOnly []*workIntelItem
	seen := map[string]bool{}
	for i := range requests {
		request := &requests[i]
		fact := current[request.RequestID]
		seen[request.RequestID] = true
		if strings.TrimSpace(request.Text) != "" {
			withText = append(withText, &workIntelItem{request: request})
			continue
		}
		// No prompt text left: what the rules would say now is not a better
		// answer than the one given when the text was there.
		if fact.Status != workintel.StatusUnclassified && fact.Status != workintel.StatusFailed {
			progress.KeptNoText++
			continue
		}
		metadataOnly = append(metadataOnly, &workIntelItem{request: request})
	}
	for _, id := range ids {
		// The request itself is gone; its fact goes with the next purge.
		if fact := current[id]; !seen[id] && fact.Status != workintel.StatusUnclassified && fact.Status != workintel.StatusFailed {
			progress.KeptNoText++
		}
	}

	// The model step runs under the worker's lock and on its counters, so the
	// job and the regular classification share one concurrency and per-minute
	// limit. With the model off this is the rules alone.
	conf := s.workIntelConf()
	worker.mu.Lock()
	llm := worker.newLLMStep(ctx, conf, snap, time.Now())
	worker.classify(ctx, snap, llm, withText)
	llm.store(ctx)
	worker.mu.Unlock()
	for _, item := range metadataOnly {
		item.feature = item.request.Features()
		item.rule = snap.engine.Classify(item.feature)
		item.final = item.rule
		item.final.NeedsLLM = false
	}

	changes := make([]store.WorkClassificationChange, 0, len(withText)+len(metadataOnly))
	for _, item := range append(withText, metadataOnly...) {
		fact := current[item.request.RequestID]
		if item.failed {
			progress.Failed++
		}
		// The rules want the model's opinion and it was not available (off, over
		// its limit, or failing). An answer a model gave earlier is better than
		// the unsettled guess, so it stays.
		if item.pending && (fact.Method == workintel.MethodLLM || fact.Method == workintel.MethodCache) {
			continue
		}
		change := store.WorkClassificationChange{RequestID: fact.RequestID, KeepManual: true}
		change.SetResult(item.final, snap.version, item.model)
		change.NeedsLLM = item.pending
		if item.failed {
			change.AddLLMAttempts = 1
		}
		same := change.CategoryID == fact.CategoryID && change.ActionType == fact.ActionType && change.Status == fact.Status
		// The cache handed back the answer the model gave for this request: it
		// stays recorded as the model's.
		if same && change.Method == workintel.MethodCache && fact.Method == workintel.MethodLLM {
			continue
		}
		if !same {
			progress.Changed++
		}
		changes = append(changes, change)
	}
	result, err := s.db.UpdateWorkClassifications(ctx, changes)
	if err != nil {
		return result, fmt.Errorf("store a chunk: %w", err)
	}
	return result, nil
}
