package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"hash/fnv"
	"math"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
)

// dynamicRouteInput is everything a route's conditions, sticky keys and rate keys
// can read. Metadata comes from the caller's metadata header; identity is the
// authenticated key, so a client cannot claim another team by sending a header.
type dynamicRouteInput struct {
	Metadata map[string]any
	Identity map[string]string
	Request  map[string]any
}

func (in dynamicRouteInput) lookup(field string) (any, bool) {
	if key, ok := strings.CutPrefix(field, "metadata."); ok {
		value, present := in.Metadata[key]
		return value, present
	}
	if key, ok := strings.CutPrefix(field, "identity."); ok {
		value := strings.TrimSpace(in.Identity[key])
		return value, value != ""
	}
	if key, ok := strings.CutPrefix(field, "request."); ok {
		value, present := in.Request[key]
		return value, present
	}
	return nil, false
}

// dynamicValueString renders a looked-up value for hashing. Numbers use the
// shortest exact form so 3 and 3.0 land in the same bucket.
func dynamicValueString(value any) string {
	switch v := value.(type) {
	case string:
		return "s:" + v
	case float64:
		return "n:" + strconv.FormatFloat(v, 'g', -1, 64)
	case bool:
		return "b:" + strconv.FormatBool(v)
	}
	return ""
}

// dynamicRouteStateStore is the shared counter behind rate elements.
// *store.SQLStore implements it; simulations use an in-memory stand-in.
type dynamicRouteStateStore interface {
	ConsumeDynamicRouteCount(ctx context.Context, routeID, elementID, scopeKey string, windowStart, windowEnd, limit int64) (bool, error)
	DynamicRouteCostUsed(ctx context.Context, routeID, elementID, scopeKey string, windowStart int64) (float64, error)
}

// dynamicRouteStep is one decision in a request's trip through a route.
type dynamicRouteStep struct {
	ElementID string `json:"id"`
	Type      string `json:"type"`
	Outcome   string `json:"outcome"`
	Detail    string `json:"detail,omitempty"`
}

// dynamicRouteCharge is a cost limit the request passed under. Its cost is added
// to the window once the response is priced.
type dynamicRouteCharge struct {
	ElementID   string
	ScopeKey    string
	WindowStart int64
	WindowEnd   int64
}

type dynamicRouteRateBlock struct {
	ElementID  string
	LimitType  string
	RetryAfter time.Duration
}

// dynamicRouteRun walks one request through a compiled route. It is not safe for
// concurrent use; each request owns its run.
type dynamicRouteRun struct {
	route     *compiledDynamicRoute
	routeID   string
	routeName string
	version   int
	input     dynamicRouteInput
	state     dynamicRouteStateStore
	now       func() time.Time
	random    func() float64

	steps       []dynamicRouteStep
	charges     []dynamicRouteCharge
	blocked     *dynamicRouteRateBlock
	modelStep   int
	attempts    int
	fallbacks   int
	finalModel  *dynamicRouteElement
	finalProv   string
	succeeded   bool
	cacheHit    bool
	lastFailure string

	// ignoreSticky makes percentage elements split at random even when their sticky
	// key is present. Only the distribution preview sets it.
	ignoreSticky bool
}

func newDynamicRouteRun(route *compiledDynamicRoute, routeID, routeName string, version int, input dynamicRouteInput, state dynamicRouteStateStore) *dynamicRouteRun {
	return &dynamicRouteRun{
		route: route, routeID: routeID, routeName: routeName, version: version,
		input: input, state: state, now: time.Now, random: rand.Float64, modelStep: -1,
	}
}

func (run *dynamicRouteRun) record(el *dynamicRouteElement, outcome, detail string) {
	run.steps = append(run.steps, dynamicRouteStep{ElementID: el.ID, Type: el.Type, Outcome: outcome, Detail: detail})
}

// walk follows the graph from elementID until it reaches a model element, which
// it returns for the caller to dial. It returns nil at an end element, at a
// dead end, or when a rate limit without a fallback stops the request (run.blocked).
func (run *dynamicRouteRun) walk(ctx context.Context, elementID string) *dynamicRouteElement {
	for guard := 0; guard <= dynamicRouteMaxElements; guard++ {
		if elementID == "" {
			return nil
		}
		el := run.route.byID[elementID]
		if el == nil {
			return nil
		}
		switch el.Type {
		case "start":
			run.record(el, "next", "")
			elementID = el.output("next")
		case "conditional":
			matched := run.route.conditions[el.ID].eval(run.input)
			outcome := strconv.FormatBool(matched)
			run.record(el, outcome, "")
			elementID = el.output(outcome)
		case "percentage":
			branch, detail := run.pickPercentage(el)
			run.record(el, branch.Key, detail)
			elementID = branch.Target
		case "rate":
			allowed, detail := run.checkRate(ctx, el)
			if allowed {
				run.record(el, "success", detail)
				elementID = el.output("success")
				continue
			}
			run.record(el, "exceeded", detail)
			if fallback := el.output("fallback"); fallback != "" {
				elementID = fallback
				continue
			}
			run.blocked = &dynamicRouteRateBlock{ElementID: el.ID, LimitType: el.Properties.LimitType, RetryAfter: run.windowRemaining(el)}
			return nil
		case "model":
			run.record(el, "selected", "")
			run.modelStep = len(run.steps) - 1
			run.attempts++
			return el
		case "end":
			run.record(el, "end", "")
			return nil
		default:
			return nil
		}
	}
	return nil
}

// start walks from the start element to the first model.
func (run *dynamicRouteRun) start(ctx context.Context) *dynamicRouteElement {
	return run.walk(ctx, run.route.startID)
}

func (run *dynamicRouteRun) markModel(outcome, detail string) {
	if run.modelStep >= 0 && run.modelStep < len(run.steps) {
		run.steps[run.modelStep].Outcome = outcome
		run.steps[run.modelStep].Detail = detail
	}
}

// succeed records that el answered. The request's route ends here.
func (run *dynamicRouteRun) succeed(el *dynamicRouteElement, provider string) {
	run.markModel("success", "")
	run.finalModel, run.finalProv, run.succeeded = el, provider, true
	if end := run.route.byID[el.output("success")]; end != nil {
		run.record(end, "end", "")
	}
}

// fail records that el could not answer (reason is a short code such as "5xx",
// "timeout" or "denied") and walks its fallback output to the next model, if any.
func (run *dynamicRouteRun) fail(ctx context.Context, el *dynamicRouteElement, outcome, reason string) *dynamicRouteElement {
	run.markModel(outcome, reason)
	run.finalModel = el
	run.lastFailure = reason
	fallback := el.output("fallback")
	if fallback == "" {
		return nil
	}
	run.fallbacks++
	return run.walk(ctx, fallback)
}

func (run *dynamicRouteRun) pickPercentage(el *dynamicRouteElement) (dynamicPercentBranch, string) {
	branches := run.route.percentages[el.ID]
	point := -1.0
	detail := ""
	if key := el.Properties.StickyKey; key != "" && !run.ignoreSticky {
		if value, ok := run.input.lookup(key); ok {
			hash := fnv.New64a()
			_, _ = hash.Write([]byte(run.routeID + "|" + el.ID + "|" + dynamicValueString(value)))
			point = float64(hash.Sum64()%1_000_000) / 10_000
			detail = "sticky"
		}
	}
	if point < 0 {
		point = run.random() * 100
	}
	for _, branch := range branches {
		if point < branch.Upper {
			return branch, detail
		}
	}
	return branches[len(branches)-1], detail
}

func (run *dynamicRouteRun) window(el *dynamicRouteElement) (int64, int64) {
	size := el.Properties.Window
	if size <= 0 {
		size = dynamicRouteMinWindow
	}
	now := run.now().Unix()
	start := now - now%size
	return start, start + size
}

func (run *dynamicRouteRun) windowRemaining(el *dynamicRouteElement) time.Duration {
	_, end := run.window(el)
	remaining := time.Unix(end, 0).Sub(run.now())
	if remaining < time.Second {
		return time.Second
	}
	return remaining
}

// scopeKey turns the value a rate element is keyed on into an opaque counter key.
// The raw value — often a user id or email — never reaches the counter table.
// A request without the value shares the element's unkeyed limit.
func (run *dynamicRouteRun) scopeKey(el *dynamicRouteElement) string {
	field := el.Properties.Key
	if field == "" {
		return ""
	}
	value, ok := run.input.lookup(field)
	if !ok {
		return ""
	}
	sum := sha256.Sum256([]byte(run.routeID + "|" + el.ID + "|" + dynamicValueString(value)))
	return "h:" + hex.EncodeToString(sum[:12])
}

// checkRate decides whether a request may pass a rate element. A counter store
// that cannot answer lets the request through: this element shapes traffic and
// cost, and the gateway's own quotas still apply, so an outage of the counter
// should not turn into an outage of the route.
func (run *dynamicRouteRun) checkRate(ctx context.Context, el *dynamicRouteElement) (bool, string) {
	if run.state == nil {
		return true, "state_unavailable"
	}
	start, end := run.window(el)
	scope := run.scopeKey(el)
	switch el.Properties.LimitType {
	case "count":
		allowed, err := run.state.ConsumeDynamicRouteCount(ctx, run.routeID, el.ID, scope, start, end, int64(math.Round(el.Properties.Limit)))
		if err != nil {
			return true, "state_unavailable"
		}
		return allowed, ""
	case "cost":
		used, err := run.state.DynamicRouteCostUsed(ctx, run.routeID, el.ID, scope, start)
		if err != nil {
			run.charges = append(run.charges, dynamicRouteCharge{ElementID: el.ID, ScopeKey: scope, WindowStart: start, WindowEnd: end})
			return true, "state_unavailable"
		}
		if used >= el.Properties.Limit {
			return false, ""
		}
		run.charges = append(run.charges, dynamicRouteCharge{ElementID: el.ID, ScopeKey: scope, WindowStart: start, WindowEnd: end})
		return true, ""
	}
	return true, ""
}

// pathHeader renders the trip compactly for the X-Dynamic-Route-Path response
// header: "start>plan:true>m1:failed>m2:success>end". Element ids are validated
// to a header-safe alphabet, so nothing here needs escaping.
func (run *dynamicRouteRun) pathHeader() string {
	parts := make([]string, 0, len(run.steps))
	for _, step := range run.steps {
		switch step.Type {
		case "start", "end":
			parts = append(parts, step.ElementID)
		default:
			parts = append(parts, step.ElementID+":"+step.Outcome)
		}
	}
	out := strings.Join(parts, ">")
	if len(out) > 1024 {
		out = out[:1021] + "..."
	}
	return out
}

func (run *dynamicRouteRun) outcome() string {
	switch {
	case run.cacheHit:
		return "cache_hit"
	case run.succeeded:
		return "success"
	case run.blocked != nil && run.lastFailure == "":
		return "rate_limited"
	case run.attempts == 0:
		return "no_model"
	default:
		return "failed"
	}
}

// ---- simulation ----

// dynamicRouteSimState stands in for the counter store during a simulation:
// listed elements behave as if their limit is spent, the rest as if it is free.
type dynamicRouteSimState struct {
	exceeded map[string]bool
}

func (s dynamicRouteSimState) ConsumeDynamicRouteCount(_ context.Context, _, elementID, _ string, _, _, _ int64) (bool, error) {
	return !s.exceeded[elementID], nil
}

func (s dynamicRouteSimState) DynamicRouteCostUsed(_ context.Context, _, elementID, _ string, _ int64) (float64, error) {
	if s.exceeded[elementID] {
		return math.Inf(1), nil
	}
	return 0, nil
}

type dynamicRouteSimulation struct {
	Steps       []dynamicRouteStep `json:"steps"`
	Path        string             `json:"path"`
	Outcome     string             `json:"outcome"`
	FinalID     string             `json:"final_element_id,omitempty"`
	FinalModel  string             `json:"final_model,omitempty"`
	Provider    string             `json:"provider,omitempty"`
	Attempts    int                `json:"attempts"`
	Fallbacks   int                `json:"fallbacks"`
	BlockedBy   string             `json:"blocked_by,omitempty"`
	RetryAfterS int64              `json:"retry_after_seconds,omitempty"`
}

type dynamicRouteSimOptions struct {
	// Exceeded lists rate elements to treat as spent.
	Exceeded map[string]bool
	// Failing lists model elements to treat as failing every attempt.
	Failing      map[string]bool
	Random       func() float64
	IgnoreSticky bool
}

// simulateDynamicRoute runs a route without calling any model. Model elements
// listed in Failing behave as if every attempt failed, which is how an operator
// checks a fallback chain before a provider actually goes down.
func simulateDynamicRoute(ctx context.Context, route *compiledDynamicRoute, routeID string, input dynamicRouteInput, opts dynamicRouteSimOptions) dynamicRouteSimulation {
	run := newDynamicRouteRun(route, routeID, "", 0, input, dynamicRouteSimState{exceeded: opts.Exceeded})
	if opts.Random != nil {
		run.random = opts.Random
	}
	run.ignoreSticky = opts.IgnoreSticky
	el := run.start(ctx)
	for el != nil {
		if opts.Failing[el.ID] {
			el = run.fail(ctx, el, "failed", "simulated")
			continue
		}
		run.succeed(el, el.Properties.Provider)
		break
	}
	result := dynamicRouteSimulation{
		Steps: run.steps, Path: run.pathHeader(), Outcome: run.outcome(),
		Attempts: run.attempts, Fallbacks: run.fallbacks,
	}
	if run.finalModel != nil {
		result.FinalID = run.finalModel.ID
		result.FinalModel = run.finalModel.Properties.Model
		result.Provider = run.finalModel.Properties.Provider
	}
	if run.blocked != nil {
		result.BlockedBy = run.blocked.ElementID
		result.RetryAfterS = int64(math.Ceil(run.blocked.RetryAfter.Seconds()))
	}
	return result
}

type dynamicRouteDistributionRow struct {
	FinalID    string  `json:"final_element_id"`
	FinalModel string  `json:"final_model"`
	Outcome    string  `json:"outcome"`
	Count      int     `json:"count"`
	Share      float64 `json:"share"`
}

// distributeDynamicRoute runs the same input many times with fresh randomness to
// show how percentage splits divide traffic across many callers. Sticky keys are
// ignored here: with one fixed input they would put every sample in one bucket,
// which says nothing about the split.
func distributeDynamicRoute(ctx context.Context, route *compiledDynamicRoute, routeID string, input dynamicRouteInput, opts dynamicRouteSimOptions, samples int) []dynamicRouteDistributionRow {
	if samples <= 0 {
		samples = 1000
	}
	opts.IgnoreSticky = true
	counts := map[string]*dynamicRouteDistributionRow{}
	order := []string{}
	for i := 0; i < samples; i++ {
		result := simulateDynamicRoute(ctx, route, routeID, input, opts)
		key := result.FinalID + "|" + result.Outcome
		row := counts[key]
		if row == nil {
			row = &dynamicRouteDistributionRow{FinalID: result.FinalID, FinalModel: result.FinalModel, Outcome: result.Outcome}
			counts[key] = row
			order = append(order, key)
		}
		row.Count++
	}
	out := make([]dynamicRouteDistributionRow, 0, len(order))
	for _, key := range order {
		row := *counts[key]
		row.Share = float64(row.Count) / float64(samples)
		out = append(out, row)
	}
	return out
}
