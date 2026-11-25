package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

// dynamicRoutesTTL bounds how long a replica serves a route version after another
// replica deployed a new one. The replica that handled the deploy drops its cache
// at once.
const dynamicRoutesTTL = 5 * time.Second

type dynamicRouteRuntime struct {
	route    store.DynamicRoute
	compiled *compiledDynamicRoute
}

type dynamicRouteSnapshot struct {
	fetchedAt time.Time
	byName    map[string]*dynamicRouteRuntime
}

type dynamicRouteCache struct {
	mu   sync.Mutex
	snap *dynamicRouteSnapshot
}

// dynamicRouteSnapshot returns the deployed routes. When the database cannot be
// read it keeps serving the last good snapshot rather than turning a short outage
// into "route not found" for every caller; with no snapshot at all it reports the
// error so the request fails as unavailable, not as missing.
func (s *Server) dynamicRouteSnapshot(ctx context.Context) (*dynamicRouteSnapshot, error) {
	s.dynamicRoutes.mu.Lock()
	defer s.dynamicRoutes.mu.Unlock()
	if cached := s.dynamicRoutes.snap; cached != nil && time.Since(cached.fetchedAt) < dynamicRoutesTTL {
		return cached, nil
	}
	deployed, err := s.db.ListDeployedDynamicRoutes(ctx)
	if err != nil {
		if cached := s.dynamicRoutes.snap; cached != nil {
			slog.Warn("dynamic route reload failed; serving the previous snapshot", "error", err)
			return cached, nil
		}
		return nil, err
	}
	snap := &dynamicRouteSnapshot{fetchedAt: time.Now(), byName: make(map[string]*dynamicRouteRuntime, len(deployed))}
	for _, item := range deployed {
		graph, parseErr := parseDynamicRouteGraph([]byte(item.Graph))
		if parseErr != nil {
			slog.Warn("deployed dynamic route graph is unreadable", "route", item.Route.Name, "version", item.Route.DeployedVersion, "error", parseErr)
			continue
		}
		compiled, validation := compileDynamicRouteGraph(normalizeDynamicRouteGraph(graph))
		if compiled == nil {
			// Saved graphs are validated, so this only happens when validation rules
			// tighten after a version was stored. Refusing the route is safer than
			// guessing what the old graph meant.
			slog.Warn("deployed dynamic route graph no longer validates", "route", item.Route.Name, "version", item.Route.DeployedVersion, "errors", len(validation.Errors))
			continue
		}
		snap.byName[strings.ToLower(item.Route.Name)] = &dynamicRouteRuntime{route: item.Route, compiled: compiled}
	}
	s.dynamicRoutes.snap = snap
	return snap, nil
}

// appendDynamicRouteModels advertises every deployed, enabled route in the model
// catalogue as "dynamic/<name>", next to the agent routes, so clients can discover
// them the same way.
func (s *Server) appendDynamicRouteModels(ctx context.Context, result *aggregatedModelsResult) {
	snap, err := s.dynamicRouteSnapshot(ctx)
	if err != nil {
		result.truncated = true
		return
	}
	names := make([]string, 0, len(snap.byName))
	for name, runtime := range snap.byName {
		if runtime.route.Enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if !appendBoundedAggregatedModel(result, map[string]any{
			"id": dynamicRouteModelPrefix + name, "object": "model", "owned_by": "dynamic-route",
			"provider": "vibe", "dynamic_route": true,
		}) {
			result.truncated = true
			return
		}
	}
}

func (s *Server) invalidateDynamicRoutes() {
	s.dynamicRoutes.mu.Lock()
	s.dynamicRoutes.snap = nil
	s.dynamicRoutes.mu.Unlock()
}

// dynamicRouteRequest is a request's state while it is served by a dynamic route.
type dynamicRouteRequest struct {
	runtime      *dynamicRouteRuntime
	run          *dynamicRouteRun
	current      *dynamicRouteElement
	virtual      string
	metadataJSON string
	// firstProvider is the provider the first model element dialed, for the
	// failover fields of the request log.
	firstProvider string
}

func (d *dynamicRouteRequest) label() string {
	return d.runtime.route.Name + "@v" + strconv.Itoa(d.runtime.route.DeployedVersion)
}

func dynamicRouteInputFor(r *http.Request, body []byte, authCtx *store.AuthContext, metadata map[string]any) dynamicRouteInput {
	input := dynamicRouteInput{
		Metadata: metadata,
		Identity: map[string]string{},
		Request:  map[string]any{"endpoint": r.URL.Path, "stream": false},
	}
	if input.Metadata == nil {
		input.Metadata = map[string]any{}
	}
	if authCtx != nil {
		input.Identity["team_id"] = authCtx.TeamID
		input.Identity["team"] = firstNonEmpty(authCtx.TeamName, authCtx.KeyTeam)
		input.Identity["user_id"] = authCtx.UserID
		input.Identity["api_key_id"] = authCtx.APIKeyID
		input.Identity["role"] = authCtx.Role
	}
	if root := jsonMap(body); root != nil {
		if stream, ok := root["stream"].(bool); ok {
			input.Request["stream"] = stream
		}
	}
	return input
}

// stepDynamicRoute resolves a "dynamic/<name>" model. It walks the deployed graph
// to the first model element, rewrites the body to that model and leaves the rest
// of the pipeline — policy, cache, cost guard — to run on the concrete model, so a
// route cannot be used to reach a model the caller could not call directly.
func (rc *requestPipeline) stepDynamicRoute() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost || !(inferencePath(r.URL.Path) || r.URL.Path == "/v1/embeddings") {
		return true
	}
	if rc.body == nil {
		body, ok := rc.readRequestBody()
		if !ok {
			return false
		}
		rc.body = body
	}
	model := strings.TrimSpace(extractModel(rc.body))
	name, ok := dynamicRouteNameFromModel(model)
	if !ok {
		return true
	}
	if rc.rejectReviewedVirtualModel() {
		return false
	}
	if !rc.authorizeAgentRouteModel(model) {
		return false
	}
	snap, err := s.dynamicRouteSnapshot(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "dynamic route lookup is unavailable", "server_error", "dynamic_route_lookup_failed")
		return false
	}
	runtime := snap.byName[name]
	if runtime == nil {
		writeOpenAIError(w, http.StatusNotFound, "dynamic route "+strconv.Quote(name)+" does not exist or has no deployed version", "invalid_request_error", "dynamic_route_not_found")
		return false
	}
	if !runtime.route.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "dynamic route "+strconv.Quote(name)+" is disabled", "invalid_request_error", "dynamic_route_disabled")
		return false
	}
	input := dynamicRouteInputFor(r, rc.body, rc.authCtx, rc.controls.Metadata)
	run := newDynamicRouteRun(runtime.compiled, runtime.route.ID, runtime.route.Name, runtime.route.DeployedVersion, input, s.db)
	rc.dynamic = &dynamicRouteRequest{
		runtime: runtime, run: run, virtual: model,
		metadataJSON: maskedMetadataJSON(rc.controls.Metadata),
	}
	w.Header().Set("X-Dynamic-Route", runtime.route.Name)
	w.Header().Set("X-Dynamic-Route-Version", strconv.Itoa(runtime.route.DeployedVersion))

	el := rc.skipDeniedDynamicModels(r.Context(), run.start(r.Context()))
	if el == nil {
		rc.setDynamicRoutePathHeader()
		switch {
		case run.blocked != nil:
			seconds := int64(math.Ceil(run.blocked.RetryAfter.Seconds()))
			w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
			w.Header().Set("X-Dynamic-Route-Limit", run.blocked.ElementID)
			writeOpenAIError(w, http.StatusTooManyRequests, "dynamic route limit "+strconv.Quote(run.blocked.ElementID)+" is exhausted for this window", "rate_limit_error", "dynamic_route_rate_limited")
		case run.attempts > 0:
			writeOpenAIError(w, http.StatusForbidden, "no model in this dynamic route is allowed for this key", "permission_error", "model_denied")
		default:
			writeOpenAIError(w, http.StatusServiceUnavailable, "dynamic route ended without selecting a model", "server_error", "dynamic_route_no_model")
		}
		return false
	}
	rc.dynamic.current = el
	rc.body = rewriteModelField(rc.body, el.Properties.Model)
	return true
}

// skipDeniedDynamicModels steps past model elements the caller's key may not use
// — by model or by pinned provider — taking each one's fallback. A route shared by
// several teams keeps working for a team whose policy excludes one of its models.
func (rc *requestPipeline) skipDeniedDynamicModels(ctx context.Context, el *dynamicRouteElement) *dynamicRouteElement {
	run := rc.dynamic.run
	for el != nil {
		if rc.authCtx == nil {
			return el
		}
		if !listAllows(el.Properties.Model, rc.authCtx.AllowedModels, rc.authCtx.DeniedModels) {
			el = run.fail(ctx, el, "skipped", "model_denied")
			continue
		}
		if provider := el.Properties.Provider; provider != "" && !listAllows(provider, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders) {
			el = run.fail(ctx, el, "skipped", "provider_denied")
			continue
		}
		return el
	}
	return nil
}

// resolveDynamicProvider resolves the provider of the current model element. When
// it has none usable — missing, disabled, or denied to this key — the element
// counts as failed and its fallback output is followed, until an element resolves
// or the graph runs out. forced is the balancer's or rule's choice for the first
// element; later elements are resolved on their own. It reports whether the
// element changed, in which case the returned body names the new model.
func (rc *requestPipeline) resolveDynamicProvider(ctx context.Context, body []byte, forced string) (resolvedProvider, []byte, bool, error) {
	run := rc.dynamic.run
	el := rc.dynamic.current
	switched := false
	for {
		target := el.Properties.Provider
		if !switched && target == "" {
			target = forced
		}
		resolved, err := rc.s.selectProviderForced(ctx, rc.r, el.Properties.Model, target)
		reason := ""
		switch {
		case err != nil:
			reason = "provider_unavailable"
		case rc.authCtx != nil && !listAllows(resolved.Name, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders):
			reason = "provider_denied"
		default:
			if switched {
				body = rewriteModelField(body, el.Properties.Model)
			}
			return resolved, body, switched, nil
		}
		next := rc.skipDeniedDynamicModels(ctx, run.fail(ctx, el, "failed", reason))
		if next == nil {
			return resolvedProvider{}, body, switched, errors.New(reason)
		}
		el, switched = next, true
		rc.dynamic.current = next
	}
}

// dynamicFallbackReason classifies a dial result. Besides what the dial loop itself
// treats as a provider failure (transport errors, timeouts, 429, 5xx), a route also
// falls back when the provider rejects the model or the credentials (401, 403, 404,
// 408): a different model on a different provider may well answer. A 400 or 422 is
// the request's own fault and would fail the same way everywhere, so it is returned.
func dynamicFallbackReason(res upstreamDialResult) (string, bool) {
	if res.err != nil {
		return fallbackReasonForError(res.err), true
	}
	if res.resp == nil {
		return "no_response", true
	}
	status := res.resp.StatusCode
	switch {
	case statusFallbackAllowed(status):
		return fallbackReasonForStatus(status), true
	case status == http.StatusUnauthorized, status == http.StatusForbidden, status == http.StatusNotFound, status == http.StatusRequestTimeout:
		return strconv.Itoa(status), true
	}
	return "", false
}

func (rc *requestPipeline) dynamicDialOptions(el *dynamicRouteElement) upstreamDialOptions {
	opts := rc.controls.dialOptions()
	opts.fixedModel = true
	props := el.Properties
	if props.Timeout > 0 {
		opts.attemptTimeout = time.Duration(props.Timeout) * time.Millisecond
	}
	if props.Retries > 0 {
		opts.maxAttempts = props.Retries + 1
	}
	if props.RetryDelay > 0 {
		opts.retryDelay = time.Duration(props.RetryDelay) * time.Millisecond
	}
	if props.Backoff != "" {
		opts.backoff = props.Backoff
	}
	return opts
}

// dynamicFailoverCandidates lists the other providers that serve model, healthiest
// first. Only a model element without a pinned provider gets them: pinning a
// provider in the graph is an explicit choice, and the graph's own fallback output
// is where an operator says what happens next.
func (rc *requestPipeline) dynamicFailoverCandidates(ctx context.Context, model, chosen string) []string {
	if clientPinnedProvider(rc.r) {
		return nil
	}
	if rc.routingPlan != nil && riskDisablesFallback(rc.routingPlan.Risk) {
		return nil
	}
	names, _ := rc.s.providersForModel(ctx, model)
	out := []string{}
	for _, name := range names {
		if name != chosen && (rc.authCtx == nil || listAllows(name, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders)) {
			out = append(out, name)
		}
	}
	out, _ = rc.s.demoteUnhealthyCandidates(ctx, out)
	return out
}

// dialDynamicRoute dials the current model element and, while elements fail,
// follows their fallback outputs through the graph — which may pass conditions,
// splits and limits again — to the next model. The response returned is the first
// one that is not a failure, or the last failure when the graph runs out.
func (rc *requestPipeline) dialDynamicRoute(ctx context.Context, body []byte, provider resolvedProvider, traceID string, candidates []string) upstreamDialResult {
	s, r := rc.s, rc.r
	dyn := rc.dynamic
	run := dyn.run
	el := dyn.current
	dyn.firstProvider = provider.Name
	path := []string{}
	retries := 0
	for {
		res := s.dialUpstreamWith(ctx, r, body, provider, traceID, candidates, rc.dynamicDialOptions(el))
		path = append(path, res.path...)
		retries += res.retries
		reason, failed := dynamicFallbackReason(res)
		if !failed {
			run.succeed(el, res.provider)
			res.path, res.retries = path, retries
			if run.fallbacks > 0 {
				res.failoverFrom = dyn.firstProvider
				res.failoverReason = "dynamic_fallback"
			}
			return res
		}
		// Find the next model this request may use and can reach. The failed
		// response stays open until there is somewhere else to go: with nowhere left
		// it is what the client receives.
		var next *dynamicRouteElement
		var nextProvider resolvedProvider
		failedElement := el
		for {
			next = rc.skipDeniedDynamicModels(ctx, run.fail(ctx, failedElement, "failed", reason))
			if next == nil {
				break
			}
			resolved, err := s.selectProviderForced(ctx, r, next.Properties.Model, next.Properties.Provider)
			if err != nil {
				failedElement, reason = next, "provider_unavailable"
				continue
			}
			if rc.authCtx != nil && !listAllows(resolved.Name, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders) {
				failedElement, reason = next, "provider_denied"
				continue
			}
			nextProvider = resolved
			break
		}
		if next == nil {
			res.path, res.retries = path, retries
			return res
		}
		if res.resp != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.resp.Body, 1<<20))
			_ = res.resp.Body.Close()
		}
		path = append(path, "dynamic_fallback:"+el.ID+"->"+next.ID)
		slog.Info("dynamic route fallback", "route", dyn.label(), "from", el.ID, "to", next.ID, "reason", reason, "trace_id", traceID)
		body = rewriteModelField(body, next.Properties.Model)
		candidates = nil
		if next.Properties.Provider == "" {
			candidates = rc.dynamicFailoverCandidates(ctx, next.Properties.Model, nextProvider.Name)
		}
		el, provider = next, nextProvider
		dyn.current = next
	}
}

func (rc *requestPipeline) setDynamicRoutePathHeader() {
	if rc.dynamic == nil {
		return
	}
	rc.w.Header().Set("X-Dynamic-Route-Path", rc.dynamic.run.pathHeader())
	if final := rc.dynamic.run.finalModel; final != nil {
		rc.w.Header().Set("X-Dynamic-Route-Element", final.ID)
	} else {
		rc.w.Header().Del("X-Dynamic-Route-Element")
	}
}

// dynamicRouteSummary is what the request's routing summary shows about the route.
func (rc *requestPipeline) dynamicRouteSummary() map[string]any {
	dyn := rc.dynamic
	run := dyn.run
	summary := map[string]any{
		"name":      dyn.runtime.route.Name,
		"version":   dyn.runtime.route.DeployedVersion,
		"path":      run.pathHeader(),
		"steps":     run.steps,
		"outcome":   run.outcome(),
		"attempts":  run.attempts,
		"fallbacks": run.fallbacks,
	}
	if run.finalModel != nil {
		summary["final_element_id"] = run.finalModel.ID
		summary["final_model"] = run.finalModel.Properties.Model
	}
	if run.blocked != nil {
		summary["blocked_by"] = run.blocked.ElementID
	}
	if len(rc.controls.Set) > 0 {
		summary["request_controls"] = rc.controls.Set
	}
	return summary
}

// setRoutingSummaryExtra stores a section of the routing summary that
// refreshRoutingSummary keeps when it rebuilds the rest.
func setRoutingSummaryExtra(req *store.RequestLog, key string, value any) {
	summary := mapFromJSON(req.RoutingSummaryJSON)
	if summary == nil {
		summary = map[string]any{}
	}
	summary[key] = value
	req.RoutingSummaryJSON = mustJSON(summary)
}

// routingSummaryExtraKeys are the sections refreshRoutingSummary carries over.
var routingSummaryExtraKeys = []string{"dynamic_route", "request_controls"}

// attachDynamicRoute fills the request log with the route's outcome. It runs once
// per record, on whichever path writes the record.
func (rc *requestPipeline) attachDynamicRoute(meta *store.LogRecord) {
	if rc.dynamic == nil || meta.DynamicRoute != nil {
		return
	}
	dyn := rc.dynamic
	run := dyn.run
	meta.Request.RequestedModel = dyn.virtual
	meta.Request.RouteReason = "dynamic_route"
	meta.Request.RouteDetail = dyn.label() + " " + run.pathHeader()
	setRoutingSummaryExtra(&meta.Request, "dynamic_route", rc.dynamicRouteSummary())
	steps, _ := json.Marshal(run.steps)
	record := &store.DynamicRouteRequest{
		RequestID:    meta.Request.ID,
		RouteID:      dyn.runtime.route.ID,
		RouteName:    dyn.runtime.route.Name,
		Version:      dyn.runtime.route.DeployedVersion,
		PathJSON:     string(steps),
		MetadataJSON: dyn.metadataJSON,
		Fallbacks:    run.fallbacks,
		Attempts:     run.attempts,
		Outcome:      run.outcome(),
		StatusCode:   meta.Request.StatusCode,
		LatencyMS:    meta.Request.LatencyMS,
		CreatedAt:    meta.Request.CreatedAt,
	}
	if run.finalModel != nil {
		record.FinalElementID = run.finalModel.ID
		record.FinalModel = run.finalModel.Properties.Model
	}
	if run.succeeded {
		record.FinalProvider = run.finalProv
	}
	if meta.Usage != nil {
		record.CostKRW = meta.Usage.EstimatedCost
	}
	meta.DynamicRoute = record
}

// dynamicCacheHitMeta is the request record to log if a response cache answers.
// For a dynamic route it carries the route's record as if the current model
// element had answered from cache, and the path header says so; the live run is
// left untouched in case the cache misses and the request goes upstream.
func (rc *requestPipeline) dynamicCacheHitMeta() store.LogRecord {
	meta := rc.meta
	if rc.dynamic == nil || rc.dynamic.current == nil {
		return meta
	}
	shadow := *rc.dynamic
	run := *rc.dynamic.run
	run.steps = append([]dynamicRouteStep(nil), rc.dynamic.run.steps...)
	run.succeed(shadow.current, "cache")
	run.markModel("cache_hit", "")
	run.cacheHit = true
	shadow.run = &run
	view := *rc
	view.dynamic = &shadow
	view.attachDynamicRoute(&meta)
	rc.w.Header().Set("X-Dynamic-Route-Path", run.pathHeader())
	rc.w.Header().Set("X-Dynamic-Route-Element", shadow.current.ID)
	return meta
}

// chargeDynamicRouteCost adds a priced request to the cost limits it passed. It is
// detached from the request: the client may be gone, and what it consumed still
// counts.
func (rc *requestPipeline) chargeDynamicRouteCost(parent context.Context, costKRW float64) {
	if rc.dynamic == nil || costKRW <= 0 || len(rc.dynamic.run.charges) == 0 {
		return
	}
	charges := append([]dynamicRouteCharge(nil), rc.dynamic.run.charges...)
	routeID, label, db := rc.dynamic.runtime.route.ID, rc.dynamic.label(), rc.s.db
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 2*time.Second)
	// Off the request path: the response, often a stream, is already complete, and
	// its last bytes should not wait on a counter write.
	go func() {
		defer cancel()
		for _, charge := range charges {
			if err := db.AddDynamicRouteCost(ctx, routeID, charge.ElementID, charge.ScopeKey, charge.WindowStart, charge.WindowEnd, costKRW); err != nil {
				slog.Warn("dynamic route cost charge failed", "route", label, "element", charge.ElementID, "error", err)
			}
		}
	}()
}
