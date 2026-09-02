package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const (
	providerHealthDefaultThreshold = 70
	providerHealthTrendBuckets     = 6
)

type providerHealthRankingItem struct {
	Rank             int     `json:"rank"`
	Provider         string  `json:"provider"`
	ProviderRef      string  `json:"provider_ref,omitempty"`
	Score            int     `json:"score"`
	Requests         int64   `json:"requests"`
	FallbackRate     float64 `json:"fallback_rate"`
	P95LatencyMS     int64   `json:"p95_latency_ms"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
}

type providerHealthAlert struct {
	Provider    string `json:"provider"`
	ProviderRef string `json:"provider_ref,omitempty"`
	Code        string `json:"code"`
	Severity    string `json:"severity"`
	Message     string `json:"message"`
}

type providerHealthTrendBucket struct {
	Since     string                      `json:"since"`
	Until     string                      `json:"until"`
	Providers []store.ProviderHealthScore `json:"providers"`
}

func (s *Server) handleRoutingPreview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	authCtx, policyKeyID, ok := s.routingPreviewAuthContext(w, r, probe)
	if !ok {
		return
	}
	plan := s.planIntelligentRouting(r.Context(), body, "/v1/chat/completions", false, false, authCtx)
	writeJSON(w, http.StatusOK, map[string]any{
		"requested_model":   plan.RequestedModel,
		"selected_model":    plan.SelectedModel,
		"selected_provider": plan.SelectedProvider,
		"policy_api_key_id": policyKeyID,
		"complexity":        plan.Complexity,
		"risk":              plan.Risk,
		"health_score":      plan.HealthScore,
		// A preview never dials upstream, so it can only report the plan. The actual
		// hop list (fallback_path) is populated on real requests and read back from
		// /admin/routing/decisions or the request explain view.
		"fallback_plan":   plan.FallbackPlan,
		"route_reason":    plan.RouteReason,
		"decision_reason": plan.DecisionReason,
		"would_rewrite":   plan.RequestedModel != "" && plan.SelectedModel != "" && plan.RequestedModel != plan.SelectedModel,
	})
}

func (s *Server) routingPreviewAuthContext(w http.ResponseWriter, r *http.Request, probe map[string]any) (*store.AuthContext, string, bool) {
	apiKeyID := strings.TrimSpace(toString(probe["api_key_id"]))
	if apiKeyID == "" {
		return nil, "", true
	}
	key, found, err := s.db.GetAPIKey(r.Context(), apiKeyID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_lookup_failed")
		return nil, "", false
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
		return nil, "", false
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && key.Team != claims.TeamID {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only preview own team api keys", "permission_error", "team_scope_denied")
		return nil, "", false
	}
	authCtx := authContextFromAPIKey(key)
	s.enrichAuthContextTeam(r.Context(), &authCtx)
	return &authCtx, key.ID, true
}

func (s *Server) handleRoutingDecisions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	decisions, err := s.db.ListRoutingDecisions(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decisions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decisions": decisions})
}

func (s *Server) handleRoutingDecisionByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/routing/decisions/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid decision id", "invalid_request_error", "invalid_decision_id")
		return
	}
	decision, err := s.db.RoutingDecisionByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "routing decision not found", "invalid_request_error", "routing_decision_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decision_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decision": decision})
}

func (s *Server) handleRoutingHealth(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var providerRef providerReferenceFunc
	if r.Header.Get("X-Vibe-UI") == "app" {
		providerRef = s.providerRefSnapshot()
	}
	since := parseWindow(r.URL.Query().Get("window"), providerHealthWindow, "hour")
	until := time.Now().UTC()
	threshold := parseProviderHealthThreshold(r.URL.Query().Get("threshold"))
	scores, err := s.db.ProviderHealthScoresBetween(r.Context(), since, until.Add(time.Nanosecond))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_health_failed")
		return
	}
	scores = boundedProviderHealthScores(scores, providerRef)
	trend, err := s.providerHealthTrend(r.Context(), since, until, providerHealthTrendBuckets, providerRef)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_health_trend_failed")
		return
	}
	breakerEnabled, breakerThreshold, breakerCooldown := s.breakerConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"since":     since.UTC().Format(time.RFC3339),
		"until":     until.Format(time.RFC3339),
		"threshold": threshold,
		"providers": scores,
		"ranking":   providerHealthRanking(scores),
		"degraded":  providerHealthDegraded(scores, threshold),
		"alerts":    providerHealthAlerts(scores, threshold),
		"trend":     trend,
		// Live circuit breaker state. Health scores are a backward-looking average;
		// this is the switch that is actually removing providers from failover right now.
		"breakers": map[string]any{
			"enabled":          breakerEnabled,
			"threshold":        breakerThreshold,
			"cooldown_seconds": int(breakerCooldown.Seconds()),
			"states":           s.breakers.snapshotWithRefs(breakerCooldown, time.Now(), providerRef),
			// With sharing on, a state may have come from a peer rather than from this
			// instance's own traffic; the operator needs to know which they are looking at.
			"shared":      s.breakerSharingEnabled(),
			"instance_id": s.instanceID,
		},
	})
}

// handleRoutingBreakerReset clears a tripped breaker on request. After fixing a
// provider an operator should not have to wait out the cooldown to confirm it.
func (s *Server) handleRoutingBreakerReset(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var providerRef providerReferenceFunc
	if r.Header.Get("X-Vibe-UI") == "app" {
		providerRef = s.providerRefSnapshot()
	}
	var payload *struct {
		Provider *string `json:"provider"`
	}
	if r.Body == nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := decoder.Decode(&payload); err != nil || payload == nil || payload.Provider == nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if err := requireJSONEOF(decoder); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if *payload.Provider != "" && strings.TrimSpace(*payload.Provider) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "provider must not contain only whitespace", "invalid_request_error", "breaker_provider_invalid")
		return
	}
	name := strings.TrimSpace(*payload.Provider)
	if name != "" && (name == "[provider-name-omitted]" || !modelsProviderLabelSafe(name)) {
		writeOpenAIError(w, http.StatusBadRequest, "redacted provider names cannot be reset individually; reset all breakers", "invalid_request_error", "breaker_provider_ambiguous")
		return
	}
	if name == "" {
		// Clear shared state first. If the atomic DB delete fails, keep the local
		// breakers intact instead of reporting a reset that the next sync can undo.
		if err := s.clearAllSharedBreakerStates(); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "failed to reset shared breaker state", "server_error", "breaker_reset_failed")
			return
		}
		s.breakers.reset("")
	} else {
		if !s.breakers.has(name) {
			writeOpenAIError(w, http.StatusNotFound, "breaker state not found", "invalid_request_error", "breaker_not_found")
			return
		}
		// Clear the shared row too: resetting only locally would leave peers skipping a
		// provider the operator has just declared healthy.
		if err := s.clearSharedBreakerStateForAdmin(name); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "failed to reset shared breaker state", "server_error", "breaker_reset_failed")
			return
		}
		s.breakers.resetExisting(name)
	}
	s.auditAdmin(r, "routing.breaker.reset", firstNonEmpty(name, "*"), "")
	_, _, cooldown := s.breakerConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "reset",
		"provider": firstNonEmpty(name, "*"),
		"states":   s.breakers.snapshotWithRefs(cooldown, time.Now(), providerRef),
	})
}

func parseProviderHealthThreshold(raw string) int {
	threshold := providerHealthDefaultThreshold
	if parsed, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
		threshold = parsed
	}
	if threshold < 0 {
		return 0
	}
	if threshold > 100 {
		return 100
	}
	return threshold
}

func boundedProviderHealthScores(scores []store.ProviderHealthScore, providerRef providerReferenceFunc) []store.ProviderHealthScore {
	out := make([]store.ProviderHealthScore, len(scores))
	copy(out, scores)
	for i := range out {
		if providerRef != nil {
			out[i].ProviderRef = providerRef(out[i].Provider)
		}
		out[i].Provider = boundedModelsProviderLabel(out[i].Provider)
	}
	return out
}

func providerHealthRanking(scores []store.ProviderHealthScore) []providerHealthRankingItem {
	ranked := append([]store.ProviderHealthScore(nil), scores...)
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		return ranked[i].Provider < ranked[j].Provider
	})
	out := make([]providerHealthRankingItem, 0, len(ranked))
	for i, score := range ranked {
		out = append(out, providerHealthRankingItem{
			Rank:             i + 1,
			Provider:         score.Provider,
			ProviderRef:      score.ProviderRef,
			Score:            score.Score,
			Requests:         score.Requests,
			FallbackRate:     score.FallbackRate,
			P95LatencyMS:     score.P95LatencyMS,
			AverageLatencyMS: score.AverageLatencyMS,
		})
	}
	return out
}

func providerHealthDegraded(scores []store.ProviderHealthScore, threshold int) []store.ProviderHealthScore {
	out := []store.ProviderHealthScore{}
	for _, score := range scores {
		if score.Requests > 0 && score.Score < threshold {
			out = append(out, score)
		}
	}
	return out
}

func providerHealthAlerts(scores []store.ProviderHealthScore, threshold int) []providerHealthAlert {
	alerts := []providerHealthAlert{}
	for _, score := range scores {
		if score.Requests == 0 {
			continue
		}
		if score.Score < threshold {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider, ProviderRef: score.ProviderRef,
				Code:     "provider_degraded",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "provider health score is below threshold",
			})
		}
		if score.Timeouts > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider, ProviderRef: score.ProviderRef,
				Code:     "timeouts_detected",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "timeout signals were observed in the selected window",
			})
		}
		if score.Rate429 > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider, ProviderRef: score.ProviderRef,
				Code:     "rate_limit_detected",
				Severity: "warning",
				Message:  "429 rate limit responses were observed in the selected window",
			})
		}
		if score.Rate5xx > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider, ProviderRef: score.ProviderRef,
				Code:     "server_error_detected",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "5xx provider responses were observed in the selected window",
			})
		}
		if score.FallbackRate >= 0.1 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider, ProviderRef: score.ProviderRef,
				Code:     "fallback_rate_high",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "fallback rate is elevated for the selected window",
			})
		}
	}
	return alerts
}

func providerHealthSeverity(score, threshold int) string {
	switch {
	case score < 40:
		return "critical"
	case score < threshold:
		return "warning"
	default:
		return "info"
	}
}

func (s *Server) providerHealthTrend(ctx context.Context, since, until time.Time, buckets int, providerRef providerReferenceFunc) ([]providerHealthTrendBucket, error) {
	if buckets <= 0 || !until.After(since) {
		return []providerHealthTrendBucket{}, nil
	}
	window := until.Sub(since)
	bucketSize := window / time.Duration(buckets)
	if bucketSize <= 0 {
		bucketSize = time.Second
	}
	trend := make([]providerHealthTrendBucket, 0, buckets)
	start := since.UTC()
	for i := 0; i < buckets && start.Before(until); i++ {
		end := start.Add(bucketSize)
		if i == buckets-1 || end.After(until) {
			end = until
		}
		queryEnd := end
		if !end.Before(until) {
			queryEnd = end.Add(time.Nanosecond)
		}
		scores, err := s.db.ProviderHealthScoresBetween(ctx, start, queryEnd)
		if err != nil {
			return nil, err
		}
		scores = boundedProviderHealthScores(scores, providerRef)
		trend = append(trend, providerHealthTrendBucket{
			Since:     start.Format(time.RFC3339),
			Until:     end.Format(time.RFC3339),
			Providers: scores,
		})
		start = end
	}
	return trend, nil
}

// handleRoutingBalancer answers "did round robin actually work?".
//
// It reports two independent views on purpose. `intent` is the balancer's own pick
// counters — what it decided. `actual` is grouped from request_logs — what really
// happened, which can differ because failover, cache hits and pinned requests never
// pass through the balancer. Agreement between the two is the signal an operator wants;
// a gap points at the reason.
//
// POST releases sticky bindings (all, or one provider's) so a node can be drained
// without waiting for every conversation's TTL to expire.
func (s *Server) handleRoutingBalancer(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	mode, sticky, ttl := s.balancerConfig()
	now := time.Now()

	if r.Method == http.MethodPost {
		var payload struct {
			Provider string `json:"provider"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&payload)
		}
		name := strings.TrimSpace(payload.Provider)
		released := s.balancer.release(name)
		s.auditAdmin(r, "routing.balancer.release", firstNonEmpty(name, "*"), auditJSON(map[string]any{"released": released}))
		writeJSON(w, http.StatusOK, map[string]any{"status": "released", "provider": firstNonEmpty(name, "*"), "released_sessions": released})
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	model := strings.TrimSpace(r.URL.Query().Get("model"))
	since := parseWindow(r.URL.Query().Get("window"), time.Hour, "hour")
	activeSessions, intent := s.balancer.stats(ttl, now)
	actual, err := s.db.ProviderModelDistribution(r.Context(), model, since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "balancer_distribution_failed")
		return
	}

	// Pools are the sets the balancer can actually spread over: a model glob served by
	// two or more enabled providers. Anything with a single provider is shown too, so
	// "why is this not balancing?" has a visible answer.
	pools := []map[string]any{}
	if providers, listErr := s.db.ListProviderConfigs(r.Context()); listErr == nil {
		byPattern := map[string][]string{}
		for _, p := range providers {
			if !p.Enabled {
				continue
			}
			for _, raw := range splitProviderPatterns(p.ModelPatterns) {
				byPattern[raw] = append(byPattern[raw], p.Name)
			}
		}
		for pattern, names := range byPattern {
			sort.Strings(names)
			pools = append(pools, map[string]any{
				"pattern": pattern, "providers": names, "size": len(names), "balanced": len(names) > 1,
			})
		}
		sort.Slice(pools, func(i, j int) bool { return pools[i]["pattern"].(string) < pools[j]["pattern"].(string) })
	}

	// round_robin keeps its rotation cursor in process memory, so N gateway instances
	// rotate independently and the same conversation can land on a different provider
	// per instance. session_hash derives the provider from the session key and needs no
	// shared state, so it is the only mode whose stickiness survives a multi-instance
	// deployment. Say so here rather than letting an operator discover it in production.
	multiInstanceSafe := mode == balanceSessionHash || mode == balanceFirst
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":                string(mode),
		"multi_instance_safe": multiInstanceSafe,
		"sticky_sessions":     sticky,
		"sticky_ttl":          ttl.String(),
		"active_sessions":     activeSessions,
		"window_since":        since.UTC().Format(time.RFC3339),
		"model":               model,
		"pools":               pools,
		"intent":              intent,
		"actual":              actual,
		"balance_index":       balanceIndex(actual),
	})
}

// balanceIndex scores how evenly traffic landed, 1.0 being a perfect split and 0
// meaning one provider took everything. It is the ratio of the least-used to the
// most-used provider, which is blunt but reads correctly at a glance and needs no
// explanation of variance to an operator.
func balanceIndex(shares []store.ProviderModelShare) float64 {
	if len(shares) < 2 {
		return 1
	}
	minReq, maxReq := shares[0].Requests, shares[0].Requests
	for _, sh := range shares {
		if sh.Requests < minReq {
			minReq = sh.Requests
		}
		if sh.Requests > maxReq {
			maxReq = sh.Requests
		}
	}
	if maxReq <= 0 {
		return 1
	}
	return float64(minReq) / float64(maxReq)
}

// handleRoutingFailoverDrill answers "if this provider dies right now, what happens?"
// without waiting for it to actually die.
//
// Every other diagnostic here describes configuration; this one walks the same
// candidate list dialUpstream would walk, marks the providers the operator names as
// failed, and reports who ends up serving the request. It sends no upstream traffic
// and mutates nothing — a drill that could take down production would never be run.
func (s *Server) handleRoutingFailoverDrill(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Model string   `json:"model"`
		Fail  []string `json:"fail"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	model := strings.TrimSpace(payload.Model)
	if model == "" {
		writeOpenAIError(w, http.StatusBadRequest, "model is required", "invalid_request_error", "missing_model")
		return
	}

	candidates, err := s.providersForModel(r.Context(), model)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "drill_failed")
		return
	}
	if len(candidates) == 0 {
		// No pattern match: the request would land on the default provider, which is
		// never a failover candidate. That is the answer, and it is usually the problem.
		candidates = []string{s.cfg.Upstream.Provider}
	}

	demoted := []string{}
	if len(candidates) > 1 {
		candidates, demoted = s.demoteUnhealthyCandidates(r.Context(), candidates)
	}

	breakerEnabled, threshold, cooldown := s.breakerConfig()
	now := time.Now()
	failed := map[string]bool{}
	for _, name := range payload.Fail {
		failed[strings.TrimSpace(name)] = true
	}

	type step struct {
		Provider string `json:"provider"`
		Outcome  string `json:"outcome"` // served | simulated_failure | skipped_breaker_open | skipped_health
		Detail   string `json:"detail,omitempty"`
	}
	steps := make([]step, 0, len(candidates))
	servedBy := ""
	for _, name := range candidates {
		switch {
		case breakerEnabled && !s.breakers.peek(name, threshold, cooldown, now):
			steps = append(steps, step{Provider: name, Outcome: "skipped_breaker_open",
				Detail: "회로 차단기가 열려 있어 시도하지 않습니다"})
		case failed[name]:
			steps = append(steps, step{Provider: name, Outcome: "simulated_failure",
				Detail: "드릴에서 실패로 지정됨"})
		default:
			steps = append(steps, step{Provider: name, Outcome: "served"})
			servedBy = name
		}
		if servedBy != "" {
			break
		}
	}

	outcome := "served"
	advice := ""
	if servedBy == "" {
		outcome = "exhausted"
		advice = "모든 후보가 실패했습니다. 같은 failover_group 에 provider 를 더 넣으면 이 시나리오를 견딥니다."
	} else if len(steps) == 1 && len(candidates) == 1 {
		outcome = "no_redundancy"
		advice = "후보가 1개뿐이라 이 provider 가 죽으면 폴백이 없습니다. failover_group 을 지정하세요."
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"model":           model,
		"candidates":      candidates,
		"failed_input":    payload.Fail,
		"health_demoted":  demoted,
		"steps":           steps,
		"served_by":       servedBy,
		"outcome":         outcome,
		"advice":          advice,
		"breaker_enabled": breakerEnabled,
	})
}
