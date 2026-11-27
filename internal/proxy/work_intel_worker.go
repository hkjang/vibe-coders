package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The work intelligence worker (docs/WORK_INTELLIGENCE_DESIGN.md, sections 3
// and 5).
//
// It follows request_logs behind a cursor and never runs on the request path:
// a request is answered and logged exactly as before, and some seconds later
// this goroutine reads it back, classifies it and updates the aggregates. If
// the worker stops, or the classification model is down, requests are not
// affected; they wait behind the cursor.
//
// One cycle:
//
//  1. take (or renew) the lease that makes this instance the worker;
//  2. read a batch after the cursor and classify it with the rules;
//  3. for what the rules could not settle, try the fingerprint cache and then,
//     when enabled and allowed, the classification model, outside any
//     database transaction and inside call, rate and time limits;
//  4. apply the batch in one transaction (facts, aggregates, cursor);
//  5. retry a few earlier requests that still wait for the model;
//  6. at most once a minute, rebuild the aggregates those reassignments made
//     stale, and at the insight interval run the periodic step.
//
// A failure of the model (transport, timeout, an answer that is not the
// expected JSON, a category that is not registered) never fails the cycle: the
// request is stored with its rule result and tried again later, up to
// workIntelMaxLLMAttempts times.

const (
	workIntelMaxLLMAttempts = 3
	// workIntelRetryBatch is how many earlier requests one cycle hands back
	// to the model. Small on purpose: new requests come first.
	workIntelRetryBatch = 20
	// workIntelRetryBackoff is the pause before a failed request is tried
	// again (four times as long before the last attempt).
	workIntelRetryBackoff = time.Minute
	// After workIntelLLMBreakerFailures failed calls in a row the model is
	// left alone for workIntelLLMBreakerPause. Requests of that time are
	// stored with their rule result and without a spent attempt, so an outage
	// of any length costs no request its later semantic result.
	workIntelLLMBreakerFailures = 5
	workIntelLLMBreakerPause    = time.Minute
	// workIntelRebuildEvery throttles the rebuild of stale aggregates, so a
	// burst of reassignments on one day rebuilds that day once.
	workIntelRebuildEvery = time.Minute
	workIntelRebuildLimit = 200
	// workIntelAccuracyTTL is how long the measured method accuracy is reused,
	// and workIntelAccuracyWindow how far back corrections count.
	workIntelAccuracyTTL    = 5 * time.Minute
	workIntelAccuracyWindow = 180 * 24 * time.Hour
	// workIntelGaugeEvery bounds how often the backlog is counted.
	workIntelGaugeEvery = 10 * time.Second
	// workIntelCatchUpPause is the wait before the next cycle when a batch
	// came back full: more is waiting, so a whole interval would be wasted.
	workIntelCatchUpPause = 100 * time.Millisecond
	workIntelStatsHours   = 25

	workIntelSkipDisabled    = "disabled"
	workIntelSkipLeaseHeld   = "lease_held"
	workIntelSkipCursorMoved = "cursor_moved"
)

// WorkIntelRunStats describes one cycle.
type WorkIntelRunStats struct {
	// Skipped is empty when the cycle ran, else why it did not: "disabled",
	// "lease_held" (another instance is the worker) or "cursor_moved"
	// (another instance applied the batch first).
	Skipped       string
	PolicyVersion int
	// Read is the number of requests read behind the cursor, Classified the
	// facts written, Ignored the requests that are not work to classify.
	Read       int
	Classified int
	Ignored    int
	ByMethod   map[string]int
	// Pending counts facts stored with their rule result that still wait for
	// the classification model.
	Pending     int
	CacheHits   int
	LLMCalls    int
	LLMFailures int
	LLMTokens   int
	// LLMBlocked is the reason code when the model step was not allowed to
	// run at all (see workIntelLLMBlocked*).
	LLMBlocked string
	// Retried counts earlier requests handed back to the model this cycle.
	Retried         int
	RetrySucceeded  int
	RebuiltDays     int
	RebuiltSessions int
	Backlog         int64
	Duration        time.Duration
}

// WorkIntelWorker classifies logged requests in the background.
type WorkIntelWorker struct {
	server *Server
	token  string
	done   chan struct{}
	wg     sync.WaitGroup
	stop   sync.Once

	// mu serializes cycles; everything below it belongs to the current cycle.
	mu           sync.Mutex
	stats        workIntelStatsDoc
	statsLoaded  bool
	accuracy     map[string]workintel.MethodAccuracy
	accuracyAt   time.Time
	rebuiltAt    time.Time
	feedbackAt   time.Time
	gaugeAt      time.Time
	cacheVersion int
	// The pacing of the model step. Fields so tests can shorten them.
	retryBackoff time.Duration
	breakerAfter int
	llmStreak    int
	llmPaused    time.Time
}

// NewWorkIntelWorker creates the worker. It does nothing until Start or
// RunOnce is called, so a Server built without it (every test that is not
// about work intelligence) never classifies anything.
func NewWorkIntelWorker(s *Server) *WorkIntelWorker {
	w := &WorkIntelWorker{server: s, token: s.instanceID + "/" + newID("wi"), done: make(chan struct{}),
		retryBackoff: workIntelRetryBackoff, breakerAfter: workIntelLLMBreakerFailures}
	// A reclassification job asks the model through this worker, so both stay
	// inside one concurrency and per-minute limit (work_intel_reclassify.go).
	s.workIntel.worker.Store(w)
	return w
}

// Start runs cycles until ctx is cancelled or Stop is called. The interval is
// read from the settings before every wait, so a change applies without a
// restart.
func (w *WorkIntelWorker) Start(ctx context.Context) {
	w.wg.Add(1)
	go w.run(ctx)
}

// Stop ends the loop, waits for the cycle in progress and gives the lease
// back so another instance can take over at once.
func (w *WorkIntelWorker) Stop() {
	w.stop.Do(func() {
		close(w.done)
		w.wg.Wait()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := w.server.db.ReleaseWorkIntelLease(ctx, w.token); err != nil {
			slog.Warn("work intel: releasing the lease failed", "error", err)
		}
	})
}

func (w *WorkIntelWorker) run(ctx context.Context) {
	defer w.wg.Done()
	timer := time.NewTimer(w.server.workIntelConf().Interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.done:
			return
		case <-timer.C:
		}
		conf := w.server.workIntelConf()
		stats := w.cycle(ctx, conf)
		next := conf.Interval
		if stats.Skipped == "" && stats.Read >= conf.BatchSize {
			next = workIntelCatchUpPause
		}
		timer.Reset(next)
	}
}

// cycle runs one RunOnce with a deadline and survives a panic: a bug in the
// classifier must cost a cycle, not the gateway process.
func (w *WorkIntelWorker) cycle(ctx context.Context, conf workIntelConfig) (stats WorkIntelRunStats) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("work intel: cycle panicked", "panic", p)
			stats = WorkIntelRunStats{Skipped: "panic"}
		}
	}()
	cycleCtx, cancel := context.WithTimeout(ctx, workIntelLeaseTTL(conf))
	defer cancel()
	// Stop interrupts a cycle instead of waiting for a slow model.
	go func() {
		select {
		case <-w.done:
			cancel()
		case <-cycleCtx.Done():
		}
	}()
	stats, err := w.RunOnce(cycleCtx)
	if err != nil && ctx.Err() == nil {
		slog.Warn("work intel: cycle failed", "error", err)
	}
	return stats
}

// workIntelLeaseTTL is how long a lease lasts without renewal: long enough
// for a whole cycle including the model calls it may wait for, short enough
// that another instance takes over within a couple of minutes.
func workIntelLeaseTTL(conf workIntelConfig) time.Duration {
	return 2*conf.Interval + conf.LLMTimeout + time.Minute
}

// RunOnce runs one cycle. It returns an error only for failures of the
// database or the cycle itself; a failing classification model is counted in
// the statistics and the cycle still succeeds.
func (w *WorkIntelWorker) RunOnce(ctx context.Context) (stats WorkIntelRunStats, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := w.server
	started := time.Now()
	stats.ByMethod = map[string]int{}
	conf := s.workIntelConf()

	// The backlog is reported by every instance, also while classification is
	// off or another instance is the worker: that is when it grows.
	defer func() {
		stats.Duration = time.Since(started)
		// Counted afresh once the cycle has caught up, when the count is small.
		// While batches come back full it is only refreshed every few seconds:
		// counting a long queue after every batch would slow the catch-up.
		caughtUp := stats.Skipped == "" && err == nil && stats.Read < conf.BatchSize
		stats.Backlog = w.refreshGauges(ctx, caughtUp)
	}()

	if !conf.ClassifyEnabled {
		stats.Skipped = workIntelSkipDisabled
		return stats, nil
	}
	held, err := s.db.AcquireWorkIntelLease(ctx, w.token, workIntelLeaseTTL(conf))
	if err != nil {
		return stats, fmt.Errorf("acquire work intel lease: %w", err)
	}
	if !held {
		// Whatever this instance remembered belongs to an earlier term.
		w.statsLoaded = false
		stats.Skipped = workIntelSkipLeaseHeld
		return stats, nil
	}
	state, err := s.db.GetWorkIntelState(ctx)
	if err != nil {
		return stats, fmt.Errorf("read work intel state: %w", err)
	}
	if !w.statsLoaded {
		// A new worker continues the totals of the one before it.
		w.stats = workIntelStatsDoc{}
		_ = json.Unmarshal([]byte(state.StatsJSON), &w.stats)
		w.statsLoaded = true
	}
	defer func() { w.finish(ctx, &stats, err, started) }()

	snap, err := s.workIntelActiveEngine(ctx, 0)
	if err != nil {
		return stats, fmt.Errorf("load work policy: %w", err)
	}
	stats.PolicyVersion = snap.version
	if w.cacheVersion != snap.version {
		// Cache keys include the policy version, so older entries are dead.
		if _, perr := s.db.PurgeWorkClassCache(ctx, snap.version); perr == nil {
			w.cacheVersion = snap.version
		}
	}

	cursor := state.Cursor
	if cursor.IngestedAt == "" {
		start := time.Now().AddDate(0, 0, -conf.BackfillDays)
		if cursor, err = s.db.InitWorkIntelCursor(ctx, start); err != nil {
			return stats, fmt.Errorf("initialise work intel cursor: %w", err)
		}
	}
	requests, next, err := s.db.WorkIntelBatch(ctx, cursor, conf.BatchSize, snap.maxInputChars)
	if err != nil {
		return stats, fmt.Errorf("read work intel batch: %w", err)
	}
	stats.Read = len(requests)

	llm := w.newLLMStep(ctx, conf, snap, started)
	// Whatever the model step did is accounted for however the cycle ends: a
	// call that was made has been paid for.
	defer func() {
		stats.CacheHits, stats.LLMCalls, stats.LLMFailures, stats.LLMTokens = llm.cacheHits, llm.calls, llm.failures, llm.tokens
		w.stats.LLMCostKRWTotal += llm.costKRW
		w.hour(started).LLMCostKRW += llm.costKRW
		w.stats.LLMBlockedCode, w.stats.LLMBlockedReason = "", ""
		if llm.block != nil && conf.LLMEnabled {
			stats.LLMBlocked = llm.block.Code
			w.stats.LLMBlockedCode, w.stats.LLMBlockedReason = llm.block.Code, llm.block.Reason
		}
	}()
	items := make([]*workIntelItem, 0, len(requests))
	for i := range requests {
		if !requests[i].Classifiable {
			stats.Ignored++
			continue
		}
		items = append(items, &workIntelItem{request: &requests[i]})
	}
	w.classify(ctx, snap, llm, items)

	facts := make([]store.WorkClassification, 0, len(items))
	for _, item := range items {
		fact := item.request.Fact()
		fact.SetResult(item.final, snap.version, item.model)
		fact.NeedsLLM = item.pending
		if item.failed {
			fact.LLMAttempts = 1
		}
		facts = append(facts, fact)
	}
	if len(requests) > 0 {
		applied, aerr := s.db.ApplyWorkIntelBatch(ctx, facts, cursor, next)
		if errors.Is(aerr, store.ErrWorkIntelCursorMoved) {
			// Another instance took the lease and this batch in between.
			stats.Skipped = workIntelSkipCursorMoved
			return stats, nil
		}
		if aerr != nil {
			return stats, fmt.Errorf("apply work intel batch: %w", aerr)
		}
		stats.Classified = applied.Inserted
		existing := make(map[string]bool, len(applied.ExistingIDs))
		for _, id := range applied.ExistingIDs {
			existing[id] = true
		}
		for _, item := range items {
			// A request that already had a fact was not classified by this cycle.
			if existing[item.request.RequestID] {
				continue
			}
			stats.ByMethod[item.final.Method]++
			if item.pending {
				stats.Pending++
			}
		}
	}
	llm.store(ctx)

	if llm.usable() {
		justClassified := make(map[string]bool, len(items))
		for _, item := range items {
			justClassified[item.request.RequestID] = true
		}
		w.retryPending(ctx, snap, llm, &stats, justClassified)
	}

	// From here on the batch is applied. What follows is upkeep: its failures
	// are reported and tried again next time, but they do not undo the cycle.
	if time.Since(w.rebuiltAt) >= workIntelRebuildEvery {
		w.rebuiltAt = time.Now()
		rebuilt, rerr := s.db.RebuildWorkIntelDirty(ctx, workIntelRebuildLimit)
		if rerr != nil {
			// The marks stay, so the next rebuild picks the same work up.
			slog.Warn("work intel: rebuilding stale aggregates failed", "error", rerr)
			w.noteError("rebuild: " + boundedWorkIntelError(rerr))
		}
		stats.RebuiltDays, stats.RebuiltSessions = len(rebuilt.Days), rebuilt.Sessions
		w.syncFeedback(ctx, conf)
	}
	if due, at := workIntelPeriodicDue(state.PeriodicAt, conf.InsightInterval, time.Now()); due {
		// Marked first: a periodic step that keeps failing must not run every cycle.
		if merr := s.db.MarkWorkIntelPeriodic(ctx, at); merr == nil {
			if perr := s.workIntelPeriodic(ctx); perr != nil {
				slog.Warn("work intel: periodic step failed", "error", perr)
				w.stats.LastError, w.stats.LastErrorAt = "periodic: "+boundedWorkIntelError(perr), formatWorkIntelTime(time.Now())
			}
		}
	}
	return stats, nil
}

func workIntelPeriodicDue(last string, interval time.Duration, now time.Time) (bool, time.Time) {
	if interval <= 0 {
		interval = defaultWorkIntelConfig().InsightInterval
	}
	if previous, err := time.Parse(time.RFC3339Nano, last); err == nil && now.Sub(previous) < interval {
		return false, now
	}
	return true, now
}

// syncFeedback confirms sessions that received positive feedback since the
// last look. The first look of a worker goes back over the backfill window.
func (w *WorkIntelWorker) syncFeedback(ctx context.Context, conf workIntelConfig) {
	since := w.feedbackAt.Add(-2 * time.Minute)
	if w.feedbackAt.IsZero() {
		days := conf.BackfillDays
		if days < 1 {
			days = 1
		}
		since = time.Now().AddDate(0, 0, -days)
	}
	started := time.Now()
	if _, err := w.server.db.SyncWorkSessionFeedback(ctx, since); err != nil {
		slog.Warn("work intel: syncing session feedback failed", "error", err)
		return
	}
	w.feedbackAt = started
}

// ---- Classification of a set of requests ----

// workIntelItem is one request on its way to a fact.
type workIntelItem struct {
	request *store.WorkIntelRequest
	feature workintel.Features
	rule    workintel.Result
	final   workintel.Result
	// key is the cache key when the request may use the cache.
	key string
	// pending: the rules asked for the model and it has not answered yet.
	// failed: the model was asked for this request in this cycle and failed.
	pending, failed bool
	// model is the classification model behind an "llm" or "cache" result.
	model string
}

// classify fills in the final result of every item: the rule result, then the
// cache, then the model.
func (w *WorkIntelWorker) classify(ctx context.Context, snap *workIntelEngineSnapshot, llm *workIntelLLMStep, items []*workIntelItem) {
	engine := snap.engine
	var keys []string
	seen := map[string]bool{}
	for _, item := range items {
		item.feature = item.request.Features()
		item.rule = engine.Classify(item.feature)
		item.final = item.rule
		item.final.NeedsLLM = false
		item.pending = item.rule.NeedsLLM
		if !item.pending {
			continue
		}
		// A request a DLP or secret policy acted on is never cached: its
		// redacted text can share a fingerprint with a harmless one.
		if item.feature.Cacheable() && item.request.Fingerprint != "" {
			item.key = store.WorkClassCacheKey(snap.version, item.request.Team, item.request.Fingerprint)
			if !seen[item.key] {
				seen[item.key] = true
				keys = append(keys, item.key)
			}
		}
	}
	if len(keys) > 0 {
		cached, err := w.server.db.GetWorkClassCache(ctx, keys)
		if err != nil {
			slog.Warn("work intel: cache lookup failed", "error", err)
		}
		for _, item := range items {
			entry, ok := cached[item.key]
			if !item.pending || item.key == "" || !ok {
				continue
			}
			item.settle(entry.Result(), workintel.MethodCache, entry.ClassifierModel)
			llm.hit(item.key)
		}
	}
	llm.run(ctx, items)
}

// settle replaces the rule result of an item with a semantic result. The
// category, action and title come from the semantic side; what the rules
// observed directly (difficulty, technologies, the system an MCP call
// targeted) is kept.
func (item *workIntelItem) settle(semantic workintel.Result, method, model string) {
	merged := workintel.MergeLLM(item.rule, semantic)
	merged.Method = method
	if merged.WorkTitle == "" {
		merged.WorkTitle = item.rule.WorkTitle
	}
	item.final, item.model = merged, model
	item.pending, item.failed = false, false
}

// workIntelLLMStep is the model step of one cycle: what it may call, how much
// it has left, and what it did.
type workIntelLLMStep struct {
	worker *WorkIntelWorker
	conf   workIntelConfig
	snap   *workIntelEngineSnapshot
	target workIntelLLMTarget
	// block is set when the step must not run at all.
	block *workIntelLLMBlock
	// startBy is when the cycle stops starting new calls. Calls already
	// started still get their full timeout, so the step takes at most one
	// interval plus one timeout however slow the model is.
	startBy time.Time

	calls, failures, tokens, cacheHits int
	costKRW                            float64
	hits                               map[string]int
	entries                            []store.WorkClassCacheEntry
}

func (w *WorkIntelWorker) newLLMStep(ctx context.Context, conf workIntelConfig, snap *workIntelEngineSnapshot, started time.Time) *workIntelLLMStep {
	step := &workIntelLLMStep{worker: w, conf: conf, snap: snap, hits: map[string]int{}, startBy: started.Add(conf.Interval)}
	if !conf.LLMEnabled {
		step.block = &workIntelLLMBlock{Code: "llm_disabled"}
		return step
	}
	if started.Before(w.llmPaused) {
		step.block = &workIntelLLMBlock{Code: workIntelLLMBlockedPaused,
			Reason: fmt.Sprintf("분류 모델 호출이 연속으로 실패해 %s까지 호출을 멈췄습니다. 그동안의 요청은 규칙 결과로 저장하고 이후에 다시 시도합니다.",
				w.llmPaused.In(time.FixedZone("KST", 9*3600)).Format("15:04:05"))}
		return step
	}
	step.target, step.block = w.server.workIntelLLMTargetFor(ctx, conf)
	return step
}

func (step *workIntelLLMStep) usable() bool { return step.block == nil }

func (step *workIntelLLMStep) hit(key string) {
	step.cacheHits++
	step.hits[key]++
}

// allowance returns how many calls the per-minute cap still permits.
func (step *workIntelLLMStep) allowance(now time.Time) int {
	return step.worker.server.workIntel.llmBudget.allowance(now, step.conf.LLMMaxPerMinute)
}

// workIntelLLMBudget is the per-minute cap on calls to the classification
// model (work_intel.llm_max_per_minute). One budget per instance is shared by
// everything that calls the model for classification: the worker's cycles,
// the reclassification jobs that run through the worker, and the policy test
// screen.
type workIntelLLMBudget struct {
	mu    sync.Mutex
	calls []time.Time
}

func (b *workIntelLLMBudget) pruneLocked(now time.Time) {
	kept := b.calls[:0]
	for _, at := range b.calls {
		if now.Sub(at) < time.Minute {
			kept = append(kept, at)
		}
	}
	b.calls = kept
}

// allowance returns how many calls the cap still permits in the minute
// ending now.
func (b *workIntelLLMBudget) allowance(now time.Time, perMinute int) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	if left := perMinute - len(b.calls); left > 0 {
		return left
	}
	return 0
}

// record counts a call made at the given time.
func (b *workIntelLLMBudget) record(at time.Time) {
	b.mu.Lock()
	b.calls = append(b.calls, at)
	b.mu.Unlock()
}

// take counts one call if the cap still permits it, and reports whether it did.
func (b *workIntelLLMBudget) take(now time.Time, perMinute int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	if len(b.calls) >= perMinute {
		return false
	}
	b.calls = append(b.calls, now)
	return true
}

func (b *workIntelLLMBudget) reset() {
	b.mu.Lock()
	b.calls = nil
	b.mu.Unlock()
}

// run asks the model about every item that is still pending. Items that share
// a cache key are asked once. What does not fit into the cycle's limits stays
// pending without counting as a failed attempt.
func (step *workIntelLLMStep) run(ctx context.Context, items []*workIntelItem) {
	if !step.usable() {
		return
	}
	type job struct {
		items []*workIntelItem
		call  workIntelLLMCall
		err   error
		ran   bool
	}
	var jobs []*job
	byKey := map[string]*job{}
	for _, item := range items {
		if !item.pending {
			continue
		}
		if item.key != "" {
			if shared := byKey[item.key]; shared != nil {
				shared.items = append(shared.items, item)
				continue
			}
		}
		j := &job{items: []*workIntelItem{item}}
		if item.key != "" {
			byKey[item.key] = j
		}
		jobs = append(jobs, j)
	}
	if allowed := step.allowance(time.Now()); len(jobs) > allowed {
		jobs = jobs[:allowed]
	}
	if len(jobs) == 0 {
		return
	}

	concurrency := step.conf.LLMConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	server := step.worker.server
	queue := make(chan *job)
	var wg sync.WaitGroup
	for i := 0; i < concurrency && i < len(jobs); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range queue {
				if ctx.Err() != nil || !time.Now().Before(step.startBy) {
					continue
				}
				j.ran = true
				func() {
					// A panic in one call is that call's failure.
					defer func() {
						if p := recover(); p != nil {
							j.err = fmt.Errorf("classification call panicked: %v", p)
						}
					}()
					j.call, j.err = server.workIntelLLMClassify(ctx, step.snap.engine, step.target, j.items[0].feature, step.conf.LLMTimeout)
				}()
			}
		}()
	}
	for _, j := range jobs {
		queue <- j
	}
	close(queue)
	wg.Wait()

	accuracy := step.worker.methodAccuracy(ctx)
	now := time.Now()
	for _, j := range jobs {
		if !j.ran {
			continue
		}
		step.calls++
		server.workIntel.llmBudget.record(now)
		step.tokens += j.call.PromptTokens + j.call.CompletionTokens
		step.costKRW += j.call.CostKRW
		if j.err != nil {
			step.failures++
			step.worker.llmStreak++
			step.worker.noteError("llm: " + boundedWorkIntelError(j.err))
			for _, item := range j.items {
				item.failed = true
			}
			continue
		}
		step.worker.llmStreak = 0
		// The model's own confidence is scaled by how often the method was
		// right when an administrator checked, and what it wrote is redacted
		// again before anything is stored or cached.
		semantic := step.snap.engine.ApplyCalibration(j.call.Result, accuracy)
		semantic = server.redactWorkIntelResult(ctx, semantic)
		for _, item := range j.items {
			item.settle(semantic, workintel.MethodLLM, step.target.model)
		}
		if key := j.items[0].key; key != "" {
			step.entries = append(step.entries, store.WorkClassCacheEntry{
				Key: key, PolicyVersion: step.snap.version, Team: j.items[0].request.Team,
				CategoryID: semantic.CategoryID, ActionType: semantic.ActionType, Confidence: semantic.Confidence, Status: semantic.Status,
				Tags: semantic.Tags, Technologies: semantic.Technologies, TargetSystem: semantic.TargetSystem, WorkTitle: semantic.WorkTitle,
				NewCategoryHint: semantic.NewCategoryHint, ClassifierModel: step.target.model,
			})
		}
	}
	if w := step.worker; w.breakerAfter > 0 && w.llmStreak >= w.breakerAfter {
		w.llmStreak = 0
		w.llmPaused = now.Add(workIntelLLMBreakerPause)
		slog.Warn("work intel: classification model keeps failing; pausing calls", "until", w.llmPaused.UTC().Format(time.RFC3339))
	}
}

// store writes what the step learned to the cache. It is best effort: a lost
// entry costs one more model call later.
func (step *workIntelLLMStep) store(ctx context.Context) {
	db := step.worker.server.db
	if len(step.entries) > 0 {
		if err := db.PutWorkClassCache(ctx, step.entries); err != nil {
			slog.Warn("work intel: storing cache entries failed", "error", err)
		}
		step.entries = nil
	}
	if len(step.hits) > 0 {
		if err := db.TouchWorkClassCache(ctx, step.hits); err != nil {
			slog.Warn("work intel: counting cache hits failed", "error", err)
		}
		step.hits = map[string]int{}
	}
}

// methodAccuracy returns how reliable each method has proven against
// administrator corrections, measured at most every few minutes.
func (w *WorkIntelWorker) methodAccuracy(ctx context.Context) map[string]workintel.MethodAccuracy {
	if w.accuracy != nil && time.Since(w.accuracyAt) < workIntelAccuracyTTL {
		return w.accuracy
	}
	measured, err := w.server.db.WorkMethodAccuracy(ctx, time.Now().Add(-workIntelAccuracyWindow))
	if err != nil {
		slog.Warn("work intel: measuring method accuracy failed", "error", err)
		if w.accuracy == nil {
			return map[string]workintel.MethodAccuracy{}
		}
		return w.accuracy
	}
	w.accuracy, w.accuracyAt = measured, time.Now()
	return measured
}

// retryPending hands a few earlier requests back to the model: those stored
// with their rule result because the model was off, over its limits or
// failing at the time. The facts are updated in place and the aggregates they
// touch are marked for the next rebuild.
func (w *WorkIntelWorker) retryPending(ctx context.Context, snap *workIntelEngineSnapshot, llm *workIntelLLMStep, stats *WorkIntelRunStats, justClassified map[string]bool) {
	s := w.server
	limit := llm.allowance(time.Now())
	if limit > workIntelRetryBatch {
		limit = workIntelRetryBatch
	}
	if limit <= 0 || ctx.Err() != nil || !time.Now().Before(llm.startBy) {
		return
	}
	candidates, err := s.db.WorkIntelPendingLLM(ctx, limit, workIntelMaxLLMAttempts, w.retryBackoff)
	if err != nil {
		slog.Warn("work intel: reading pending classifications failed", "error", err)
		return
	}
	// What this cycle just stored has had its turn with the model, or was
	// refused one by this cycle's limits.
	pending := candidates[:0]
	for _, fact := range candidates {
		if !justClassified[fact.RequestID] {
			pending = append(pending, fact)
		}
	}
	if len(pending) == 0 {
		return
	}
	ids := make([]string, len(pending))
	for i, fact := range pending {
		ids[i] = fact.RequestID
	}
	requests, err := s.db.WorkIntelRequests(ctx, ids, snap.maxInputChars)
	if err != nil {
		slog.Warn("work intel: reading pending requests failed", "error", err)
		return
	}
	byID := make(map[string]*store.WorkIntelRequest, len(requests))
	for i := range requests {
		byID[requests[i].RequestID] = &requests[i]
	}
	var items []*workIntelItem
	var changes []store.WorkClassificationChange
	for _, fact := range pending {
		request := byID[fact.RequestID]
		// The prompt is kept for a shorter time than the request. Without it
		// there is nothing to ask the model, so the rule result stands.
		if request == nil || strings.TrimSpace(request.Text) == "" {
			changes = append(changes, store.WorkClassificationChange{RequestID: fact.RequestID, NeedsLLM: false})
			continue
		}
		items = append(items, &workIntelItem{request: request})
	}
	w.classify(ctx, snap, llm, items)
	for _, item := range items {
		change := store.WorkClassificationChange{RequestID: item.request.RequestID, KeepManual: true}
		switch {
		case item.failed:
			change.NeedsLLM, change.AddLLMAttempts = true, 1
		case item.pending:
			// Not asked this cycle (limits): nothing to record.
			continue
		default:
			change.SetResult(item.final, snap.version, item.model)
			change.NeedsLLM = false
			if item.final.Method != workintel.MethodRule {
				stats.RetrySucceeded++
			}
		}
		changes = append(changes, change)
	}
	stats.Retried = len(items)
	if len(changes) > 0 {
		if _, err := s.db.UpdateWorkClassifications(ctx, changes); err != nil {
			slog.Warn("work intel: storing retried classifications failed", "error", err)
			w.noteError("retry: " + boundedWorkIntelError(err))
		}
	}
	llm.store(ctx)
}

// ---- Statistics ----

// workIntelStatsDoc is the compact statistics document kept in
// work_intel_state.stats_json, so the status of the worker can be read on any
// instance and survives a restart or a change of worker.
type workIntelStatsDoc struct {
	ProcessedTotal   int64                `json:"processed_total"`
	IgnoredTotal     int64                `json:"ignored_total"`
	ByMethod         map[string]int64     `json:"by_method"`
	FailuresTotal    int64                `json:"failures_total"`
	LLMCallsTotal    int64                `json:"llm_calls_total"`
	LLMTokensTotal   int64                `json:"llm_tokens_total"`
	LLMCostKRWTotal  float64              `json:"llm_cost_krw_total"`
	CacheHitsTotal   int64                `json:"cache_hits_total"`
	PolicyVersion    int                  `json:"policy_version"`
	LastRunAt        string               `json:"last_run_at"`
	LastError        string               `json:"last_error"`
	LastErrorAt      string               `json:"last_error_at"`
	LastBatchSize    int                  `json:"last_batch_size"`
	LastBatchMS      int64                `json:"last_batch_ms"`
	LLMBlockedCode   string               `json:"llm_blocked_code"`
	LLMBlockedReason string               `json:"llm_blocked_reason"`
	Hours            []workIntelHourStats `json:"hours"`
}

// workIntelHourStats is one hour of activity; the last 25 are kept so a
// rolling 24-hour figure can be read at any minute.
type workIntelHourStats struct {
	Hour       string  `json:"hour"`
	Processed  int64   `json:"processed"`
	Failures   int64   `json:"failures"`
	LLMCalls   int64   `json:"llm_calls"`
	LLMTokens  int64   `json:"llm_tokens"`
	LLMCostKRW float64 `json:"llm_cost_krw"`
	CacheHits  int64   `json:"cache_hits"`
}

func formatWorkIntelTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

func workIntelHourKey(t time.Time) string {
	return t.UTC().Format("2006-01-02T15")
}

// hour returns the bucket of the hour t falls in, dropping the oldest ones.
func (w *WorkIntelWorker) hour(t time.Time) *workIntelHourStats {
	key := workIntelHourKey(t)
	if n := len(w.stats.Hours); n == 0 || w.stats.Hours[n-1].Hour != key {
		w.stats.Hours = append(w.stats.Hours, workIntelHourStats{Hour: key})
		if extra := len(w.stats.Hours) - workIntelStatsHours; extra > 0 {
			w.stats.Hours = append([]workIntelHourStats(nil), w.stats.Hours[extra:]...)
		}
	}
	return &w.stats.Hours[len(w.stats.Hours)-1]
}

func (w *WorkIntelWorker) noteError(message string) {
	w.stats.LastError, w.stats.LastErrorAt = message, formatWorkIntelTime(time.Now())
}

// boundedWorkIntelError keeps an error readable in a status row without
// letting it grow into a log dump.
func boundedWorkIntelError(err error) string {
	message := strings.Join(strings.Fields(err.Error()), " ")
	if len(message) > 300 {
		message = strings.ToValidUTF8(message[:300], "") + "…"
	}
	return message
}

// finish folds a cycle into the statistics, the metrics and the persisted
// copy. It runs for every cycle this instance ran as the worker, also a
// failed one.
func (w *WorkIntelWorker) finish(ctx context.Context, stats *WorkIntelRunStats, cycleErr error, started time.Time) {
	s := w.server
	elapsed := time.Since(started)
	doc := &w.stats
	if doc.ByMethod == nil {
		doc.ByMethod = map[string]int64{}
	}
	bucket := w.hour(started)
	doc.LastRunAt = formatWorkIntelTime(started)
	doc.PolicyVersion = stats.PolicyVersion
	if stats.Skipped == "" && cycleErr == nil {
		doc.ProcessedTotal += int64(stats.Classified)
		doc.IgnoredTotal += int64(stats.Ignored)
		bucket.Processed += int64(stats.Classified)
		for method, n := range stats.ByMethod {
			doc.ByMethod[method] += int64(n)
			s.metrics.AddWorkIntelProcessed(method, n)
		}
		if stats.Read > 0 {
			doc.LastBatchSize, doc.LastBatchMS = stats.Read, elapsed.Milliseconds()
			s.metrics.ObserveWorkIntelBatch(elapsed)
		}
	}
	doc.FailuresTotal += int64(stats.LLMFailures)
	doc.LLMCallsTotal += int64(stats.LLMCalls)
	doc.LLMTokensTotal += int64(stats.LLMTokens)
	doc.CacheHitsTotal += int64(stats.CacheHits)
	bucket.Failures += int64(stats.LLMFailures)
	bucket.LLMCalls += int64(stats.LLMCalls)
	bucket.LLMTokens += int64(stats.LLMTokens)
	bucket.CacheHits += int64(stats.CacheHits)
	s.metrics.AddWorkIntelLLM(stats.LLMCalls, stats.CacheHits)
	s.metrics.AddWorkIntelFailures(stats.LLMFailures)
	if cycleErr != nil {
		doc.FailuresTotal++
		bucket.Failures++
		s.metrics.AddWorkIntelFailures(1)
		w.noteError(boundedWorkIntelError(cycleErr))
	}

	encoded, err := json.Marshal(doc)
	if err != nil {
		return
	}
	// The cycle's context may be the reason it failed; the statistics are
	// written on their own short one.
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.db.SaveWorkIntelStats(saveCtx, w.token, string(encoded)); err != nil {
		slog.Warn("work intel: saving statistics failed", "error", err)
	}
}

// workIntelGaugeSnapshot is the backlog as last counted by this instance.
type workIntelGaugeSnapshot struct {
	backlog    int64
	capped     bool
	lagSeconds float64
	at         time.Time
}

// refreshGauges counts the backlog for /metrics, at most every few seconds
// unless the cycle just changed it.
func (w *WorkIntelWorker) refreshGauges(ctx context.Context, force bool) int64 {
	s := w.server
	if previous := s.workIntel.gauges.Load(); previous != nil && !force && time.Since(w.gaugeAt) < workIntelGaugeEvery {
		return previous.backlog
	}
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	backlog, capped, lag, err := s.db.WorkIntelBacklog(readCtx)
	if err != nil {
		if previous := s.workIntel.gauges.Load(); previous != nil {
			return previous.backlog
		}
		return 0
	}
	w.gaugeAt = time.Now()
	s.workIntel.gauges.Store(&workIntelGaugeSnapshot{backlog: backlog, capped: capped, lagSeconds: lag.Seconds(), at: w.gaugeAt})
	return backlog
}

// ---- Shared runtime state on the Server ----

// workIntelRuntimeState is the part of work intelligence every instance
// keeps, worker or not: the compiled policy and the last counted backlog.
type workIntelRuntimeState struct {
	engine   atomic.Pointer[workIntelEngineSnapshot]
	engineMu sync.Mutex
	gauges   atomic.Pointer[workIntelGaugeSnapshot]
	// worker is the worker this instance created, if any.
	worker atomic.Pointer[WorkIntelWorker]
	// llmBudget is the per-minute cap on classification calls of this instance.
	llmBudget workIntelLLMBudget
}

// workIntelEngineSnapshot is a compiled policy version.
type workIntelEngineSnapshot struct {
	engine        *workintel.Engine
	version       int
	publishedAt   string
	maxInputChars int
	// fallback is true when the stored policy did not compile and the
	// built-in one is classifying in its place; issue says why.
	fallback  bool
	issue     string
	checkedAt time.Time
}

// workIntelActiveEngine returns the engine of the latest published policy.
// The policy is compiled once per version; maxAge is how long the cached
// engine may be used without asking the database whether a newer version was
// published (0 asks every time, which is one indexed MAX).
func (s *Server) workIntelActiveEngine(ctx context.Context, maxAge time.Duration) (*workIntelEngineSnapshot, error) {
	if cached := s.workIntel.engine.Load(); cached != nil && maxAge > 0 && time.Since(cached.checkedAt) < maxAge {
		return cached, nil
	}
	s.workIntel.engineMu.Lock()
	defer s.workIntel.engineMu.Unlock()
	cached := s.workIntel.engine.Load()
	version, err := s.db.LatestWorkPolicyVersionNumber(ctx)
	if err != nil {
		if cached != nil {
			// Keep classifying with the last known policy through a database blip.
			return cached, nil
		}
		return nil, err
	}
	if cached != nil && version != 0 && cached.version == version {
		refreshed := *cached
		refreshed.checkedAt = time.Now()
		s.workIntel.engine.Store(&refreshed)
		return &refreshed, nil
	}
	latest, err := s.db.LatestWorkPolicyVersion(ctx)
	if err != nil {
		if cached != nil {
			return cached, nil
		}
		return nil, err
	}
	snap := &workIntelEngineSnapshot{version: latest.Version, publishedAt: latest.PublishedAt, checkedAt: time.Now()}
	var policy workintel.Policy
	if err := json.Unmarshal([]byte(latest.ConfigJSON), &policy); err != nil {
		snap.issue = "stored policy is not valid JSON"
	} else if engine, issues := workintel.Compile(policy); len(issues) > 0 {
		snap.issue = issues[0].Path + ": " + issues[0].Message
	} else {
		snap.engine = engine
	}
	if snap.engine == nil {
		// A policy that cannot be compiled must not stop classification, and
		// must not go unnoticed either.
		slog.Error("work intel: published policy does not compile; classifying with the built-in policy", "version", latest.Version, "issue", snap.issue)
		snap.engine, snap.fallback = workintel.DefaultEngine(), true
	}
	snap.maxInputChars = snap.engine.Policy().LLM.MaxInputChars
	s.workIntel.engine.Store(snap)
	return snap, nil
}

// workIntelStatus is the state of the worker as GET /admin/work-intel/status
// reports it. It is read from the database, so any instance can answer.
type workIntelStatus struct {
	ClassifyEnabled    bool             `json:"classify_enabled"`
	AnalyticsEnabled   bool             `json:"analytics_enabled"`
	LLMEnabled         bool             `json:"llm_enabled"`
	LLMModel           string           `json:"llm_model"`
	LLMExternalAllowed bool             `json:"llm_external_allowed"`
	LLMBlockedCode     string           `json:"llm_blocked_code"`
	LLMBlockedReason   string           `json:"llm_blocked_reason"`
	PolicyVersion      int              `json:"policy_version"`
	PolicyFallback     bool             `json:"policy_fallback"`
	CursorAt           string           `json:"cursor_at"`
	LagSeconds         float64          `json:"lag_seconds"`
	Backlog            int64            `json:"backlog"`
	BacklogCapped      bool             `json:"backlog_capped"`
	LastRunAt          string           `json:"last_run_at"`
	LastError          string           `json:"last_error"`
	LastErrorAt        string           `json:"last_error_at"`
	LastBatchSize      int              `json:"last_batch_size"`
	LastBatchMS        int64            `json:"last_batch_ms"`
	ProcessedTotal     int64            `json:"processed_total"`
	Processed24h       int64            `json:"processed_24h"`
	ByMethod           map[string]int64 `json:"by_method"`
	Failures24h        int64            `json:"failures_24h"`
	LLMCalls24h        int64            `json:"llm_calls_24h"`
	LLMTokens24h       int64            `json:"llm_tokens_24h"`
	LLMCostKRW24h      float64          `json:"llm_cost_krw_24h"`
	CacheHits24h       int64            `json:"cache_hits_24h"`
	WorkerActive       bool             `json:"worker_active"`
}

// workIntelStatus assembles the status from the settings, the state row and
// the statistics the worker last persisted.
func (s *Server) workIntelStatus(ctx context.Context) (workIntelStatus, error) {
	conf := s.workIntelConf()
	out := workIntelStatus{
		ClassifyEnabled: conf.ClassifyEnabled, AnalyticsEnabled: conf.AnalyticsEnabled, LLMEnabled: conf.LLMEnabled,
		LLMModel: conf.LLMModel, LLMExternalAllowed: conf.LLMAllowExternal, ByMethod: map[string]int64{},
	}
	state, err := s.db.GetWorkIntelState(ctx)
	if err != nil {
		return out, err
	}
	now := time.Now()
	out.WorkerActive = state.LeaseActive(now)
	out.CursorAt = state.Cursor.IngestedAt
	backlog, capped, lag, err := s.db.WorkIntelBacklog(ctx)
	if err != nil {
		return out, err
	}
	out.Backlog, out.BacklogCapped, out.LagSeconds = backlog, capped, lag.Seconds()
	if snap, err := s.workIntelActiveEngine(ctx, 5*time.Second); err == nil {
		out.PolicyVersion, out.PolicyFallback = snap.version, snap.fallback
	}

	var doc workIntelStatsDoc
	_ = json.Unmarshal([]byte(state.StatsJSON), &doc)
	out.LastRunAt, out.LastError, out.LastErrorAt = doc.LastRunAt, doc.LastError, doc.LastErrorAt
	out.LastBatchSize, out.LastBatchMS = doc.LastBatchSize, doc.LastBatchMS
	out.ProcessedTotal = doc.ProcessedTotal
	out.LLMBlockedCode, out.LLMBlockedReason = doc.LLMBlockedCode, doc.LLMBlockedReason
	for method, n := range doc.ByMethod {
		out.ByMethod[method] = n
	}
	// The hour that began 24 hours ago is included: a rolling day read at any
	// minute, rounded up to whole hours.
	oldest := workIntelHourKey(now.Add(-24 * time.Hour))
	hours := append([]workIntelHourStats(nil), doc.Hours...)
	sort.Slice(hours, func(i, j int) bool { return hours[i].Hour < hours[j].Hour })
	for _, h := range hours {
		if h.Hour < oldest {
			continue
		}
		out.Processed24h += h.Processed
		out.Failures24h += h.Failures
		out.LLMCalls24h += h.LLMCalls
		out.LLMTokens24h += h.LLMTokens
		out.LLMCostKRW24h += h.LLMCostKRW
		out.CacheHits24h += h.CacheHits
	}
	return out, nil
}

// workIntelMetrics renders the work intelligence series of /metrics. The
// gauges are what this instance last counted; they are not read from the
// database here, so a scrape never waits for it.
func (s *Server) workIntelMetrics() string {
	var backlog int64
	var lag float64
	if g := s.workIntel.gauges.Load(); g != nil {
		backlog, lag = g.backlog, g.lagSeconds
	}
	return s.metrics.WorkIntelPrometheus(backlog, lag)
}

// ---- Periodic step ----

// workIntelPeriodic is the slow, aggregate-level step the worker runs every
// work_intel.insight_interval: retention of the aggregates, then the
// generation of trend signals, automation candidates and insights.
func (s *Server) workIntelPeriodic(ctx context.Context) error {
	conf := s.workIntelConf()
	purged, err := s.db.PurgeWorkIntelOlderThan(ctx, conf.RetentionDays)
	if err != nil {
		return fmt.Errorf("purge old work aggregates: %w", err)
	}
	if purged > 0 {
		slog.Info("work intel: purged old aggregates", "rows", purged, "retention_days", conf.RetentionDays)
	}
	if !conf.InsightEnabled {
		return nil
	}
	return s.workIntelGenerateInsights(ctx)
}

// workIntelGenerateInsights computes trend signals, automation candidates and
// insights from the aggregates and stores them as one generation
// (work_automation_candidates, work_insights). The work is in
// work_intel_insights.go; POST /admin/work-intel/insights/run runs the same step.
func (s *Server) workIntelGenerateInsights(ctx context.Context) error {
	_, err := s.workIntelGenerate(ctx)
	return err
}
