package proxy

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

// PipelineStep is one named stage of the OpenAI-compatible request pipeline.
// Steps run in order; each returns false to halt the pipeline, in which case it
// has already written the client response (error, cache hit, quota block, etc.).
// Returning true passes control (and the shared requestPipeline state) to the
// next step. This makes the previously-inline handleOpenAI flow explicit:
//
//	Auth → Quota → MCP Discovery → Routing → Skill → Deprecation → Limits → Governance → Cache → Cost → Upstream
type PipelineStep interface {
	// Name is a short stable identifier used in logs/metrics/tests.
	Name() string
	// Run executes the step against the shared pipeline state.
	Run(rc *requestPipeline) bool
}

// stepFunc adapts a (name, func) pair to the PipelineStep interface so steps can
// stay as methods on requestPipeline without a type per stage.
type stepFunc struct {
	name string
	run  func(*requestPipeline) bool
}

func (f stepFunc) Name() string                 { return f.name }
func (f stepFunc) Run(rc *requestPipeline) bool { return f.run(rc) }

// requestPipeline carries the mutable state threaded through the steps of a
// single /v1/* request. It replaces the long list of locals that used to live
// directly in handleOpenAI; behaviour is identical, only the structure is named.
type requestPipeline struct {
	s *Server
	w http.ResponseWriter
	r *http.Request

	isModelsGet bool
	apiKeyID    string
	authCtx     *store.AuthContext
	body        []byte
	traceID     string

	// When an unpinned model aggregation cannot return any provider, the classic
	// compatibility path remains available but must retain the aggregate bounds.
	modelsAggregateFallback bool
	modelsAggregateResult   aggregatedModelsResult

	routeDecision routingDecision
	routingPlan   *intelligentRoutingPlan
	meta          store.LogRecord

	estimatedCostKRW float64

	chatCacheKey    string
	chatCacheable   bool
	chatCacheScope  string
	chatSemanticVec []float64

	skillName    string
	skillVersion string
	skillTools   string

	// An enabled agent route is resolved before the normal routing/skill/deprecation
	// stages. If that virtual model is sunset, stepAgentRoute applies its deprecation
	// exactly once and records the transition here. The normal deprecation stage skips
	// only the same replacement model; if routing or a skill selects a different model,
	// that effective model still receives the existing post-routing deprecation check.
	agentRouteDeprecatedFrom   string
	agentRouteDeprecationModel string

	// policyEvents collects the governance decisions of every phase, written once at the
	// end of the request. See the deferred flush in handleOpenAI.
	policyEvents []store.PolicyDecisionEvent

	// quotaReserved is the request id holding an in-flight quota reservation, if any.
	// It must be released on every exit path or the reservation counts against the
	// quota until it expires.
	quotaReserved string

	// affinity identifies the conversation for provider stickiness (see
	// resolveSessionAffinity). Empty when balancing does not apply.
	affinity sessionAffinity
}

// pipelineSteps returns the ordered request pipeline. The order is the contract:
// authentication first, then quota enforcement, optional MCP model discovery,
// intelligent routing, governance (policy/secret/MCP/knowledge), response caches,
// pre-call cost guard, and finally the upstream dial + response relay.
func (rc *requestPipeline) steps() []PipelineStep {
	return []PipelineStep{
		stepFunc{"auth", (*requestPipeline).stepAuth},
		stepFunc{"quota", (*requestPipeline).stepQuota},
		stepFunc{"agent_route", (*requestPipeline).stepAgentRoute},
		stepFunc{"mcp_discovery", (*requestPipeline).stepMCPDiscovery},
		stepFunc{"routing", (*requestPipeline).stepRouting},
		stepFunc{"skill", (*requestPipeline).stepSkill},
		stepFunc{"deprecation", (*requestPipeline).stepDeprecation},
		stepFunc{"limits", (*requestPipeline).stepLimits},
		stepFunc{"governance", (*requestPipeline).stepGovernance},
		stepFunc{"cache", (*requestPipeline).stepCache},
		stepFunc{"cost", (*requestPipeline).stepCost},
		stepFunc{"upstream", (*requestPipeline).stepUpstream},
	}
}

// stepAuth resolves the caller identity. /v1/models GET is anonymous; everything
// else requires a valid proxy/upstream key. The resolved id is echoed back so
// clients/operators can confirm which key the gateway attributed the call to.
func (rc *requestPipeline) stepAuth() bool {
	s, r, w := rc.s, rc.r, rc.w

	rc.isModelsGet = r.Method == http.MethodGet && r.URL.Path == "/v1/models"
	if rc.isModelsGet {
		// /v1/models는 인증 불필요 — anonymous로 처리
		rc.apiKeyID = "anonymous"
	} else if injected, ok := injectedChatTestAuth(r.Context()); ok {
		rc.apiKeyID = injected.APIKeyID
		rc.authCtx = injected.AuthCtx
	} else {
		var outcome authOutcome
		rc.apiKeyID, rc.authCtx, outcome = s.authenticateProxyContextWithOutcome(r)
		switch outcome {
		case authUnavailable:
			// The credential could not be checked, so the request is refused — but this is
			// an outage, not a bad key. 503 is retryable where 401 is not, and the message
			// points at the store so nobody spends an incident reissuing keys.
			w.Header().Set("Retry-After", "5")
			writeOpenAIError(w, http.StatusServiceUnavailable,
				"cannot verify credentials right now: the gateway database is unreachable. The request was refused rather than allowed unverified; retry shortly.",
				"server_error", "auth_backend_unavailable")
			return false
		case authDenied:
			writeOpenAIError(w, http.StatusUnauthorized, "invalid proxy API key", "invalid_request_error", "invalid_api_key")
			return false
		}
	}

	// echo the resolved identity so clients/operators can verify which key the
	// gateway attributed the request to (e.g. confirm a newly-issued key is used).
	w.Header().Set("X-Api-Key-Id", rc.apiKeyID)
	return true
}

// stepQuota enforces API key / team / IP / global token+KRW quotas before any
// body is read or upstream work is done.
func (rc *requestPipeline) stepQuota() bool {
	s, r, w := rc.s, rc.r, rc.w

	clientAddr := clientIP(r)
	// Authentication already read this key's row, so its team is in hand. Looking it up
	// again is a round trip for a value the request is holding.
	//
	// The id comparison is a guard, not a case that arises today: every branch of stepAuth
	// sets apiKeyID and authCtx from the same lookup. It is here because the cost of being
	// wrong is charging a request to another team's quota, and a future auth path that
	// sets one without the other would do exactly that in silence.
	var knownTeam *string
	if rc.authCtx != nil && rc.authCtx.APIKeyID == rc.apiKeyID {
		knownTeam = &rc.authCtx.KeyTeam
	}
	if decision, err := s.checkQuotas(r.Context(), rc.apiKeyID, clientAddr, knownTeam); err != nil {
		slog.Warn("quota check failed", "error", err)
	} else if !decision.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(quotaRetryAfterSeconds(decision.PeriodEnd)))
		w.Header().Set("X-Quota-Scope", quotaHeaderTag(decision))
		w.Header().Set("X-Quota-Tokens", strconv.FormatInt(decision.Tokens, 10))
		w.Header().Set("X-Quota-Cost-KRW", formatKRW(decision.CostKRW))
		// Without the limit the totals above mean nothing, and without the reserved
		// split a caller sees a number larger than the usage their own dashboard
		// shows, with no way to account for the difference.
		if decision.Quota.TokenLimit > 0 {
			w.Header().Set("X-Quota-Token-Limit", strconv.FormatInt(decision.Quota.TokenLimit, 10))
		}
		if decision.Quota.KRWLimit > 0 {
			w.Header().Set("X-Quota-Cost-Limit-KRW", formatKRW(decision.Quota.KRWLimit))
		}
		if decision.ReservedTokens > 0 || decision.ReservedCostKRW > 0 {
			w.Header().Set("X-Quota-Reserved-Tokens", strconv.FormatInt(decision.ReservedTokens, 10))
			w.Header().Set("X-Quota-Reserved-Cost-KRW", formatKRW(decision.ReservedCostKRW))
		}
		w.Header().Set("X-Quota-Period-Start", decision.PeriodStart.Format(time.RFC3339))
		w.Header().Set("X-Quota-Period-End", decision.PeriodEnd.Format(time.RFC3339))
		s.metrics.IncQuotaBlock()
		writeOpenAIError(w, http.StatusTooManyRequests, "quota exceeded: "+decision.Reason, "quota_error", decision.Reason)
		return false
	}
	return true
}

// stepRouting reads the body, computes the trace id, runs intelligent routing
// (complexity/risk scoring + auto-alias model rewrite), and builds the audit
// record (meta) that the remaining steps annotate.
func (rc *requestPipeline) stepRouting() bool {
	s, r, w := rc.s, rc.r, rc.w

	body := rc.body
	if body == nil && r.Body != nil {
		var ok bool
		if body, ok = rc.readRequestBody(); !ok {
			return false
		}
	}
	rc.body = body
	originalBody := append([]byte(nil), body...)

	traceID := traceIDFromRequest(r)
	rc.traceID = traceID

	// Intelligent routing: score complexity/risk, expand auto model aliases, and
	// optionally rewrite the requested model/provider when the client did not pin routing.
	var routeDecision routingDecision
	pinned := strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) != "" || strings.TrimSpace(r.URL.Query().Get("provider")) != ""
	noRoute := strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Proxy-No-Route")), "1")
	var routingPlan *intelligentRoutingPlan
	if r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
		plan := s.planIntelligentRouting(r.Context(), body, r.URL.Path, pinned, noRoute, rc.authCtx)
		routingPlan = &plan
		w.Header().Set("X-Routing-Complexity", strconv.Itoa(plan.Complexity.Score))
		w.Header().Set("X-Routing-Complexity-Tier", plan.Complexity.Tier)
		w.Header().Set("X-Routing-Risk", strconv.Itoa(plan.Risk.Score))
		if containsString(plan.Risk.Categories, "prompt_injection") {
			s.metrics.IncPromptInjection()
			w.Header().Set("X-Prompt-Injection", "detected")
		}
		if rc.authCtx != nil && (plan.SelectedModel == "" || !listAllows(plan.SelectedModel, rc.authCtx.AllowedModels, rc.authCtx.DeniedModels)) {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "model_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: plan.SelectedModel, CreatedAt: time.Now().UTC()})
			writeOpenAIError(w, http.StatusForbidden, "model is not allowed by auth policy", "permission_error", "model_denied")
			return false
		}
		shouldRewriteModel := !noRoute && plan.SelectedModel != "" && plan.RequestedModel != "" && plan.SelectedModel != plan.RequestedModel &&
			(!pinned || isAutoModelAlias(plan.RequestedModel))
		if shouldRewriteModel {
			body = rewriteModelField(body, plan.SelectedModel)
			routeDecision = routingDecision{
				Applied:       true,
				OriginalModel: plan.RequestedModel,
				TargetModel:   plan.SelectedModel,
				Desc:          plan.DecisionReason,
				Reason:        plan.RouteReason,
			}
			if !pinned && plan.ForceProvider {
				routeDecision.TargetProvider = plan.SelectedProvider
			}
			w.Header().Set("X-Routed-Model", plan.SelectedModel)
		} else if !pinned && !noRoute && plan.ForceProvider && plan.SelectedProvider != "" {
			routeDecision.TargetProvider = plan.SelectedProvider
		}
	}
	rc.body = body

	// The routing plan above already extracted and redacted these prompts from the same
	// body; reuse them rather than paying for it twice a few lines apart.
	var prePrompts []store.PromptLog
	if routingPlan != nil {
		prePrompts = routingPlan.Prompts
	}
	meta := s.auditRequestWithPrompts(r.URL.Path, body, rc.apiKeyID, traceID, r, prePrompts)
	applyOpenAIRequestBodySummary(&meta.Request, originalBody, r.URL.Path)
	if routingPlan != nil {
		meta.Request.Complexity = routingPlan.Complexity.Score
		if routingPlan.RequestedModel != "" && routingPlan.RequestedModel != meta.Request.Model {
			meta.Request.RequestedModel = routingPlan.RequestedModel
		}
		meta.Request.ResolvedModel = firstNonEmpty(routingPlan.SelectedModel, meta.Request.Model)
		meta.Request.UpstreamModel = meta.Request.ResolvedModel
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
	}
	if routeDecision.Applied {
		meta.Request.RequestedModel = routeDecision.OriginalModel
		meta.Request.ResolvedModel = routeDecision.TargetModel
		meta.Request.UpstreamModel = routeDecision.TargetModel
		s.metrics.IncRoutingOverride()
	}
	if rc.agentRouteDeprecatedFrom != "" {
		// stepRouting sees the already-rewritten body. Preserve what the client
		// actually requested while leaving ResolvedModel/UpstreamModel aligned with
		// the replacement (or any later intelligent-routing decision).
		meta.Request.RequestedModel = rc.agentRouteDeprecatedFrom
	}
	refreshRoutingSummary(&meta.Request, routingPlan)

	rc.routeDecision = routeDecision
	rc.routingPlan = routingPlan
	rc.meta = meta
	return true
}

// stepGovernance applies request-phase policy enforcement (allow/block/approval +
// secret firewall), records inferred VCS activity, expands knowledge-cache
// references, and enforces MCP server allowlist/block policy.
func (rc *requestPipeline) stepGovernance() bool {
	s, r, w := rc.s, rc.r, rc.w

	if r.Method == http.MethodPost {
		var blocked bool
		rc.body, blocked = s.enforceOpenAIGovernance(w, r, &rc.meta, rc.body, rc.authCtx, rc.routingPlan, 0, true, "request", &rc.policyEvents)
		if blocked {
			return false
		}
	}

	// Inferred VCS: mine git commit/push activity out of the conversation so the VCS
	// tab shows commits even without any webhook setup. Best-effort, async.
	if s.cfg.VCS.InferFromContent && r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
		sid, akid, b := rc.meta.Request.SessionID, rc.meta.Request.APIKeyID, rc.body
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			s.recordInferredVCS(ctx, sid, akid, b)
		}()
	}

	// Knowledge cache: expand {{kb:slug}} references / X-Vibe-Knowledge into the body
	// sent upstream. Audit (above) keeps the compact reference; the model gets full text.
	if r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
		if expanded, ids, tokens := s.expandKnowledge(r, rc.body); len(ids) > 0 {
			rc.body = expanded
			w.Header().Set("X-Knowledge-Expanded", strings.Join(ids, ","))
			kbIDs, ctxKeys := splitExpandedRefs(ids)
			if len(ctxKeys) > 0 {
				w.Header().Set("X-Context-Expanded", strings.Join(ctxKeys, ","))
			}
			s.metrics.AddKnowledgeExpansion(tokens)
			go func(kbIDs, ctxKeys []string) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if len(kbIDs) > 0 {
					_ = s.db.TouchKnowledge(ctx, kbIDs)
				}
				if len(ctxKeys) > 0 {
					_ = s.db.TouchContextRegistry(ctx, ctxKeys)
				}
			}(kbIDs, ctxKeys)
		}
	}

	// MCP server policy (allowlist / block) — reject requests that use a disallowed
	// MCP server before they ever reach the upstream.
	if s.enforceMCPPolicy(w, r, rc.meta, rc.traceID) {
		return false
	}
	return true
}

// stepCache serves idempotent responses without an upstream call: the embedding
// cache for /v1/embeddings and the opt-in deterministic chat cache. It also
// records chat-cache eligibility so the upstream step can populate the cache.
func (rc *requestPipeline) stepCache() bool {
	s, r, w := rc.s, rc.r, rc.w

	// Embedding cache (idempotent) — only applies to /v1/embeddings + POST.
	if r.URL.Path == "/v1/embeddings" && r.Method == http.MethodPost && s.cacheConf().EmbeddingEnabled {
		if served := s.serveEmbeddingFromCache(r.Context(), w, r, rc.body,
			chatCacheScopeValue(s.cacheConf().EmbeddingScope, rc.authCtx, rc.apiKeyID), rc.meta, rc.traceID); served {
			return false
		}
	}

	// Chat response cache — opt-in, only for deterministic (temp 0 / seed) requests.
	rc.chatCacheScope = chatCacheScopeValue(s.cacheConf().ChatScope, rc.authCtx, rc.apiKeyID)
	rc.chatCacheKey, rc.chatCacheable = s.chatCacheEligible(r, rc.body, rc.authCtx, rc.apiKeyID)
	if rc.chatCacheable {
		if served := s.serveChatFromCache(r.Context(), w, rc.chatCacheKey, rc.meta, rc.traceID); served {
			return false
		}
		// Exact miss → try the embedding-based semantic cache (opt-in). The query vector
		// is kept on rc so a fresh upstream response is stored under it.
		if vec, served := s.serveChatSemantic(r.Context(), w, r, rc.body, rc.chatCacheScope, rc.meta, rc.traceID); served {
			return false
		} else {
			rc.chatSemanticVec = vec
		}
	}
	return true
}

// stepCost runs pre-call cost prediction: it exposes estimate headers, enforces a
// per-key budget limit, re-checks governance with the predicted cost, and applies
// the cost guard threshold (overridable via X-Cost-Approve).
func (rc *requestPipeline) stepCost() bool {
	s, r, w := rc.s, rc.r, rc.w

	rc.estimatedCostKRW = 0.0
	if r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
		snap := s.costSnapshotCached(r.Context())
		est := predictCost(rc.meta.Request.Model, promptTokenEstimate(rc.meta.Prompts), parseMaxTokens(rc.body), snap, s.pricingMap(r.Context()))
		rc.estimatedCostKRW = est.CostKRW
		// Record what this request is expected to consume while it runs, so requests
		// starting alongside it count it. stepQuota cannot do this — it runs before the
		// body is read, so no estimate exists yet.
		s.reserveQuota(r.Context(), rc.meta.Request.ID, rc.apiKeyID, clientIP(r),
			int64(est.InputTokens+est.OutputTokens), est.CostKRW)
		rc.quotaReserved = rc.meta.Request.ID
		w.Header().Set("X-Estimated-Input-Tokens", strconv.Itoa(est.InputTokens))
		w.Header().Set("X-Estimated-Output-Tokens", strconv.Itoa(est.OutputTokens))
		if est.Priced {
			w.Header().Set("X-Estimated-Cost-KRW", formatKRW(est.CostKRW))
		}
		if est.LatencyMS > 0 {
			w.Header().Set("X-Estimated-Latency-MS", strconv.Itoa(int(est.LatencyMS+0.5)))
		}
		if rc.authCtx != nil && rc.authCtx.BudgetLimitKRW > 0 && est.Priced && est.CostKRW > rc.authCtx.BudgetLimitKRW {
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "budget_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: formatKRW(est.CostKRW) + " > " + formatKRW(rc.authCtx.BudgetLimitKRW), CreatedAt: time.Now().UTC()})
			writeOpenAIError(w, http.StatusPaymentRequired, "estimated cost exceeds key budget limit", "budget_error", "budget_denied")
			return false
		}
		var blocked bool
		rc.body, blocked = s.enforceOpenAIGovernance(w, r, &rc.meta, rc.body, rc.authCtx, rc.routingPlan, rc.estimatedCostKRW, false, "cost", &rc.policyEvents)
		if blocked {
			return false
		}
		if snap.guardEnabled && snap.guardThreshold > 0 && est.Priced && est.CostKRW > snap.guardThreshold &&
			!strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Cost-Approve")), "1") {
			s.metrics.IncCostGuardBlock()
			w.Header().Set("X-Cost-Guard", "blocked")
			s.notifyMattermost(r.Context(), "cost", "비용 가드 차단: 예상 비용 "+formatKRW(est.CostKRW)+" > 임계값 "+formatKRW(snap.guardThreshold)+" (model "+rc.meta.Request.Model+")")
			writeOpenAIError(w, http.StatusPaymentRequired,
				"estimated cost "+formatKRW(est.CostKRW)+" exceeds the cost guard threshold "+formatKRW(snap.guardThreshold)+
					"; resend with header 'X-Cost-Approve: 1' to proceed", "cost_guard_error", "cost_threshold_exceeded")
			return false
		}
	}
	// Embeddings consume quota too, and a batch job fires them by the thousand
	// concurrently — exactly the shape that overshoots a limit. They were reserving
	// nothing, so they counted only after finishing, which is the very gap reservations
	// exist to close.
	//
	// predictCost is not reused here: it always predicts a completion, and an embedding
	// has none, so every call would be over-reserved by the default output estimate and
	// legitimate traffic would start being refused.
	if r.URL.Path == "/v1/embeddings" && r.Method == http.MethodPost && s.quotaReservationsEnabled() {
		inputTokens := promptTokenEstimate(rc.meta.Prompts)
		cost := 0.0
		if audit.ModelPriced(rc.meta.Request.Model, s.pricingMap(r.Context())) {
			cost = audit.EstimateCostKRW(rc.meta.Request.Model, audit.Usage{
				PromptTokens: inputTokens,
			}, s.pricingMap(r.Context()))
		}
		s.reserveQuota(r.Context(), rc.meta.Request.ID, rc.apiKeyID, clientIP(r), int64(inputTokens), cost)
		rc.quotaReserved = rc.meta.Request.ID
	}

	return true
}

// stepUpstream selects the provider (honouring auth policy + routing override),
// applies provider-phase governance, dials the upstream with failover, relays the
// response (streaming or buffered), and enqueues the finalized audit record.
func (rc *requestPipeline) stepUpstream() bool {
	s, r, w := rc.s, rc.r, rc.w
	meta := rc.meta
	body := rc.body
	traceID := rc.traceID
	routingPlan := rc.routingPlan

	// Text2SQL: a vibe/text2sql-* virtual model is not proxied verbatim — it runs the
	// Text2SQL pipeline (generate read-only SQL via a real upstream model, validate,
	// optionally execute) and writes a normal Chat Completion response here.
	if s.t2sConf().Enabled && r.Method == http.MethodPost && text2sql.IsModel(meta.Request.Model) {
		// Kill switch: an operator can disable Text2SQL at runtime (incident/cost/
		// security) without a redeploy. The virtual model then returns a clear, safe
		// message instead of generating or executing any SQL.
		if s.t2sKilled.Load() {
			s.writeChatCompletion(w, meta.Request.Model, "Text2SQL 기능이 현재 운영자에 의해 일시 중지되었습니다. 잠시 후 다시 시도해 주세요.")
			return false
		}
		s.handleText2SQL(w, r, meta, body, rc.authCtx)
		return false
	}

	// Unpinned GET /v1/models: serve the union of every enabled provider's catalogue so a
	// caller sees all reachable models, not just the default provider's. A pinned request
	// (X-Proxy-Provider / ?provider=) keeps the classic single-provider passthrough below,
	// and aggregation falling short (no provider reachable) also falls through to it. The
	// fallback shares the same deadline so an all-provider timeout cannot start a second full
	// provider timeout after the aggregate budget has already elapsed.
	if rc.isModelsGet && !clientPinnedProvider(r) {
		modelsCtx, cancelModels := context.WithTimeout(r.Context(), s.modelsCatalogTimeout())
		defer cancelModels()
		r = r.WithContext(modelsCtx)
		rc.r = r
		if rc.serveAggregatedModels() {
			return false
		}
	}

	// Load balancing: when several providers serve the same model, spread sessions
	// across them instead of always taking the first match by name. A routing rule's
	// target (rc.routeDecision.TargetProvider) is an explicit decision and outranks
	// the pool, so the balancer only runs when nothing has been forced already.
	forcedProvider := rc.routeDecision.TargetProvider
	balanced := balancerDecision{}
	// Resolve the conversation identity before the balancer, not inside it: it is also
	// what the upstream session header is derived from, and that has to happen even when
	// a rule or a header has already pinned the provider.
	rc.affinity = resolveSessionAffinity(r, body, rc.apiKeyID, meta.Request.SessionID)
	s.injectUpstreamSessionHeader(w, r, rc.affinity)
	if !rc.modelsAggregateFallback && strings.TrimSpace(forcedProvider) == "" {
		if decision, ok := s.balanceProvider(r.Context(), r, meta.Request.Model, rc.affinity.Key, rc.authCtx); ok {
			forcedProvider, balanced = decision.Provider, decision
		}
	}

	var provider resolvedProvider
	var err error
	if rc.modelsAggregateFallback {
		provider, err = s.modelsFallbackProvider(r.Context())
	} else {
		provider, err = s.selectProviderForced(r.Context(), r, meta.Request.Model, forcedProvider)
	}
	if err != nil {
		if rc.modelsAggregateFallback {
			status := http.StatusBadGateway
			code := "models_fallback_provider_unavailable"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(r.Context().Err(), context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
				code = "models_fallback_deadline_exceeded"
			}
			rc.writeModelsFallbackError(&meta, status, code, time.Now())
			return false
		}
		writeOpenAIError(w, http.StatusBadGateway, "provider is unavailable", "server_error", "provider_unavailable")
		return false
	}
	if balanced.Provider != "" {
		// selectProviderForced labels any forced choice "rule_provider"; restore the
		// real reason so route_reason distinguishes rotation from stickiness.
		provider.Reason, provider.Detail = balanced.Reason, balanced.Detail
	}
	if rc.authCtx != nil && !listAllows(provider.Name, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders) {
		providerLabel := boundedModelsProviderLabel(provider.Name)
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "model_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "provider:" + providerLabel, CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusForbidden, "provider is not allowed by auth policy", "permission_error", "provider_denied")
		return false
	}
	meta.Request.Provider = provider.Name
	meta.Request.RouteReason = provider.Reason
	meta.Request.RouteDetail = provider.Detail
	if rc.routeDecision.Applied {
		// the model choice is the salient decision; surface it as the routing reason.
		meta.Request.RouteReason = firstNonEmpty(rc.routeDecision.Reason, "complexity_rule")
		meta.Request.RouteDetail = rc.routeDecision.Desc
	}
	if routingPlan != nil {
		routingPlan.SelectedProvider = provider.Name
		routingPlan.HealthScore = s.healthScoreForProvider(r.Context(), provider.Name)
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, provider.Name)
	}
	if rc.modelsAggregateFallback {
		meta.Request.Provider = boundedModelsProviderLabel(provider.Name)
		meta.Request.RouteReason = "models_fallback"
		meta.Request.RouteDetail = aggregatedModelsAuditDetail(rc.modelsAggregateResult)
	}
	if r.Method == http.MethodPost {
		var blocked bool
		body, blocked = s.enforceOpenAIGovernance(w, r, &meta, body, rc.authCtx, routingPlan, rc.estimatedCostKRW, false, "provider", &rc.policyEvents)
		if blocked {
			return false
		}
	}
	// Provider names remain raw only while routing and governance need the configured
	// identity. From this point onward request/routing logs and client metadata use a
	// bounded label, including legacy rows created before validation existed.
	selectedProviderRaw := provider.Name
	meta.Request.Provider = boundedModelsProviderLabel(provider.Name)
	if routingPlan != nil {
		routingPlan.SelectedProvider = meta.Request.Provider
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
	}

	// Identify failover candidates: only when the client did NOT explicitly pin a provider.
	failoverCandidates := []string{}
	fallbackAllowed := routingPlan == nil || !riskDisablesFallback(routingPlan.Risk)
	if !rc.modelsAggregateFallback && fallbackAllowed && strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) == "" && strings.TrimSpace(r.URL.Query().Get("provider")) == "" {
		if cands, _ := s.providersForModel(r.Context(), meta.Request.Model); len(cands) > 1 {
			for _, name := range cands {
				if name != provider.Name {
					failoverCandidates = append(failoverCandidates, name)
				}
			}
			// A degraded-but-answering provider still costs a full request and its
			// latency before failover. Push it to the back rather than dropping it.
			var demoted []string
			failoverCandidates, demoted = s.demoteUnhealthyCandidates(r.Context(), failoverCandidates)
			if len(demoted) > 0 {
				safeDemoted := make([]string, 0, len(demoted))
				for _, name := range demoted {
					safeDemoted = append(safeDemoted, boundedModelsProviderLabel(name))
				}
				// Say so: reordering that cannot be seen is exactly the opacity this
				// gateway's routing work has been undoing.
				w.Header().Set("X-Health-Demoted", strings.Join(safeDemoted, ","))
				slog.Info("health demoted failover candidates",
					"demoted", safeDemoted, "threshold", s.healthDemoteThreshold(), "trace_id", traceID)
			}
		}
	}

	start := time.Now()
	releaseModelsSlot := func() {}
	if rc.modelsAggregateFallback {
		var slotErr error
		releaseModelsSlot, slotErr = s.acquireModelsCatalogSlot(r.Context())
		if slotErr != nil {
			rc.writeModelsFallbackError(&meta, http.StatusGatewayTimeout, "models_fallback_deadline_exceeded", start)
			return false
		}
	}
	resp, resolvedName, failoverFrom, failoverReason, failoverPath, finalBody, finalModel, upstreamHeaders, err := s.dialUpstream(r.Context(), r, body, provider, traceID, failoverCandidates)
	if finalBody != nil {
		body = finalBody
	}
	if finalModel != "" && finalModel != meta.Request.Model {
		meta.Request.Model = finalModel
		meta.Request.UpstreamModel = finalModel
		if routingPlan != nil {
			routingPlan.SelectedModel = finalModel
		}
	}
	if err != nil {
		releaseModelsSlot()
		if rc.modelsAggregateFallback {
			status := http.StatusBadGateway
			code := "models_fallback_upstream_unavailable"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(r.Context().Err(), context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
				code = "models_fallback_deadline_exceeded"
			}
			rc.writeModelsFallbackError(&meta, status, code, start)
			return false
		}
		s.metrics.IncUpstreamError()
		status := statusForUpstreamError(err)
		meta.Request.StatusCode = status
		meta.Request.LatencyMS = time.Since(start).Milliseconds()
		reason := fallbackReasonForError(err)
		meta.Request.Error = "upstream_" + reason
		meta.Request.FallbackReason = reason
		if routingPlan != nil {
			routingPlan.FallbackPath = append(routingPlan.FallbackPath, failoverPath...)
			meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
		}
		applyUpstreamHeaderSummary(&meta.Request, upstreamHeaders, nil, w.Header())
		setRoutingHeaders(w, provider, meta.Request.Provider, failoverFrom, failoverReason, failoverPath)
		refreshRoutingSummary(&meta.Request, routingPlan)
		meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{})
		s.metrics.ObserveLLMEvaluations(meta.Evaluations)
		rc.recordSkillRun(rc.skillName, rc.skillVersion, "error", meta.Request.Model, 0, meta.Request.LatencyMS)
		s.enqueue(meta)
		s.notifyMattermost(r.Context(), "provider", "Provider 장애: "+meta.Request.Provider+" 요청 실패 ("+reason+")")
		message := "upstream request failed"
		if reason == "timeout" {
			message = "upstream request timed out"
		}
		writeOpenAIError(w, status, message, "server_error", "upstream_request_failed")
		return false
	}
	defer resp.Body.Close()
	if failoverFrom != "" {
		s.metrics.IncFailover()
		meta.Request.Failover = true
		if rc.modelsAggregateFallback {
			meta.Request.FallbackFrom = boundedModelsProviderLabel(failoverFrom)
			meta.Request.FallbackReason = "models_fallback"
		} else {
			meta.Request.FallbackFrom = boundedModelsProviderLabel(failoverFrom)
			meta.Request.FallbackReason = failoverReason
		}
	}
	if resolvedName != "" {
		if rc.modelsAggregateFallback {
			meta.Request.Provider = boundedModelsProviderLabel(resolvedName)
		} else {
			meta.Request.Provider = boundedModelsProviderLabel(resolvedName)
		}
	}
	// A failover means the bound provider did not serve this turn. Move the binding to
	// the one that did, otherwise every later turn would retry the bad node first.
	if rc.affinity.Key != "" && meta.Request.Provider != "" {
		rebindProvider := firstNonEmpty(resolvedName, selectedProviderRaw)
		s.balancer.rebind(meta.Request.Model, rc.affinity.Key, rebindProvider, time.Now())
	}
	meta.Request.ResolvedModel = firstNonEmpty(meta.Request.ResolvedModel, meta.Request.Model)
	meta.Request.UpstreamModel = firstNonEmpty(finalModel, meta.Request.UpstreamModel, meta.Request.Model)
	if routingPlan != nil {
		routingPlan.SelectedProvider = meta.Request.Provider
		if len(failoverPath) > 0 {
			routingPlan.FallbackPath = append(routingPlan.FallbackPath, failoverPath...)
		}
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
	}
	refreshRoutingSummary(&meta.Request, routingPlan)

	if rc.modelsAggregateFallback {
		boundedBody, validationErr := readBoundedModelsFallbackBody(resp)
		releaseModelsSlot()
		if validationErr != nil {
			code := providerModelsFailureCode(validationErr)
			if isProviderModelsLimitError(validationErr) {
				rc.modelsAggregateResult.truncated = true
			}
			rc.writeModelsFallbackError(&meta, http.StatusBadGateway, code, start)
			return false
		}
		resp.Body = io.NopCloser(bytes.NewReader(boundedBody))
		// A model catalogue has no response metadata that must be trusted from the
		// fallback provider. Replace the entire header map so cookies, redirects,
		// auth values, and vendor diagnostics cannot cross the public boundary.
		resp.Header = http.Header{"Content-Type": []string{"application/json"}}
	}

	stream := meta.Request.Stream || strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	s.metrics.IncRequest(stream)
	meta.Request.Stream = stream
	meta.Request.StatusCode = resp.StatusCode

	if rc.modelsAggregateFallback {
		w.Header().Set("Content-Type", "application/json")
		setAggregatedModelsHeaders(w, rc.modelsAggregateResult)
	} else {
		copyDownstreamHeaders(w.Header(), resp.Header)
	}
	applyUpstreamHeaderSummary(&meta.Request, upstreamHeaders, resp.Header, w.Header())

	var responseBody io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		gzipReader, err := gzip.NewReader(resp.Body)
		if err == nil {
			defer gzipReader.Close()
			responseBody = gzipReader
			w.Header().Del("Content-Encoding")
		} else {
			slog.Warn("failed to create gzip reader for response", "trace_id", traceID, "error", err)
		}
	}

	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
	}
	if rc.modelsAggregateFallback {
		w.Header().Set("X-Provider", boundedModelsProviderLabel(firstNonEmpty(resolvedName, provider.Name)))
		w.Header().Set("X-Route-Reason", "models_fallback")
	} else {
		setRoutingHeaders(w, provider, meta.Request.Provider, failoverFrom, failoverReason, failoverPath)
	}
	if rc.affinity.Key != "" {
		// Echo how the conversation was identified so a client can confirm that its
		// turns really are landing on one provider — and see why if they are not.
		w.Header().Set("X-Session-Affinity", rc.affinity.Source)
		w.Header().Set("X-Session-Affinity-Key", shortSession(rc.affinity.Key))
	}
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(resp.StatusCode)

	captureForCache := !stream && r.URL.Path == "/v1/embeddings" && s.cacheConf().EmbeddingEnabled
	captureForChatCache := !stream && rc.chatCacheable && resp.StatusCode == http.StatusOK
	lc := s.loggingConf()
	captureLimit := lc.ResponseMaxBytes
	if (captureForCache || captureForChatCache) && s.cacheConf().EmbeddingMaxBytes > captureLimit {
		captureLimit = s.cacheConf().EmbeddingMaxBytes
	}
	isRedteam := r.Header.Get("X-Redteam") == "1" || meta.Request.CostCenter == "redteam" || strings.Contains(r.Header.Get("X-Session-ID"), "redteam:")
	analyzer := NewResponseAnalyzer(stream, captureForCache || captureForChatCache || lc.ResponseText || isRedteam, captureLimit)
	firstChunkMS, firstChunkSeen, copyErr := s.copyResponse(w, responseBody, analyzer, stream, start)
	if firstChunkSeen {
		meta.Request.FirstChunkMS = firstChunkMS
		s.metrics.ObserveFirstChunk(firstChunkMS)
	}
	if copyErr != nil && !errors.Is(copyErr, context.Canceled) {
		meta.Request.Error = copyErr.Error()
		slog.Warn("downstream copy failed", "trace_id", traceID, "error", copyErr)
	}
	meta.Request.LatencyMS = time.Since(start).Milliseconds()
	s.metrics.ObserveLatency(meta.Request.LatencyMS)

	analysis := analyzer.Finalize()
	if captureForCache && analysis.Text != "" {
		s.maybeStoreEmbeddingCache(r.Context(), body,
			chatCacheScopeValue(s.cacheConf().EmbeddingScope, rc.authCtx, rc.apiKeyID), resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForChatCache && analysis.Text != "" {
		s.maybeStoreChatCache(r.Context(), rc.chatCacheKey, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
		s.maybeStoreChatSemantic(r.Context(), rc.body, rc.chatCacheScope, rc.chatSemanticVec, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForCache || captureForChatCache {
		s.metrics.IncCacheMiss()
	}
	// Determine what to persist as response text.
	// CompletionText is the clean extracted content (not raw SSE/JSON).
	// Text (raw capture) is kept only for cache replay; never persisted to the log.
	responseText := ""
	if lc.ResponseText || isRedteam {
		if analysis.CompletionText != "" {
			responseText = analysis.CompletionText
		} else {
			responseText = analysis.Text
		}
	}
	meta.Response = &store.ResponseLog{
		ID:                   newID("resp"),
		RequestID:            meta.Request.ID,
		StatusCode:           resp.StatusCode,
		FinishReason:         analysis.FinishReason,
		ResponseHash:         analysis.Hash,
		ResponseTextOptional: responseText,
		CreatedAt:            time.Now().UTC(),
	}
	// AI code output verification gate: when the completion text was captured (response-text
	// logging or cache), persist a safe code verdict (risk/counts/findings) tied to this
	// request+trace. The raw code is never stored — only metadata. No-op when there is no code.
	if resp.StatusCode < 400 {
		cvText := analysis.CompletionText
		if cvText == "" {
			cvText = analysis.Text
		}
		meta.CodeVerify = buildCodeVerifyLog(meta.Request.ID, traceID, cvText)
	}
	if analysis.HasUsage {
		meta.Usage = &store.TokenUsage{
			ID:               newID("usage"),
			RequestID:        meta.Request.ID,
			PromptTokens:     analysis.Usage.PromptTokens,
			CompletionTokens: analysis.Usage.CompletionTokens,
			TotalTokens:      analysis.Usage.TotalTokens,
			CachedTokens:     analysis.Usage.CachedTokens,
			ReasoningTokens:  analysis.Usage.ReasoningTokens,
			EstimatedCost:    audit.EstimateCostKRW(meta.Request.Model, analysis.Usage, s.pricingMap(r.Context())),
			Currency:         "KRW",
			Source:           analysis.Usage.Source,
			CreatedAt:        time.Now().UTC(),
		}
	} else if promptEstimate, completionEstimate := promptTokenEstimate(meta.Prompts), analysis.CompletionTokensEstimate; promptEstimate > 0 || completionEstimate > 0 {
		estimated := audit.Usage{
			PromptTokens:     promptEstimate,
			CompletionTokens: completionEstimate,
			TotalTokens:      promptEstimate + completionEstimate,
			Source:           "estimated",
		}
		meta.Usage = &store.TokenUsage{
			ID:               newID("usage"),
			RequestID:        meta.Request.ID,
			PromptTokens:     estimated.PromptTokens,
			CompletionTokens: estimated.CompletionTokens,
			TotalTokens:      estimated.TotalTokens,
			EstimatedCost:    audit.EstimateCostKRW(meta.Request.Model, estimated, s.pricingMap(r.Context())),
			Currency:         "KRW",
			Source:           estimated.Source,
			CreatedAt:        time.Now().UTC(),
		}
	}
	if len(analysis.ToolCalls) > 0 {
		meta.Tools = append(meta.Tools, toolInvocations(meta.Request, analysis.ToolCalls)...)
	}
	s.metrics.ObserveToolInvocations(meta.Tools)
	meta.Evaluations = buildLLMEvaluations(meta, analysis)
	s.metrics.ObserveLLMEvaluations(meta.Evaluations)
	if rc.skillName != "" {
		cost := rc.estimatedCostKRW
		if meta.Usage != nil {
			cost = meta.Usage.EstimatedCost
		}
		status := "ok"
		if meta.Request.StatusCode >= 400 {
			status = "error"
		}
		rc.recordSkillRun(rc.skillName, rc.skillVersion, status, meta.Request.Model, cost, meta.Request.LatencyMS)
	}
	applyUpstreamHeaderSummary(&meta.Request, upstreamHeaders, resp.Header, w.Header())
	refreshRoutingSummary(&meta.Request, routingPlan)
	s.enqueue(meta)
	return true
}

// setRoutingHeaders tells the caller which upstream actually served the request and
// why it was chosen, so provider routing is observable from the client without
// opening the admin UI. Previously only X-Failover-From was exposed, which left the
// far more common "which provider handled this?" question unanswerable.
//
//	X-Provider          resolved provider that produced the response
//	X-Route-Reason      how it was picked: header | query | model_pattern | rule_provider | default
//	X-Route-Detail      the matched glob / header name / env var behind that reason
//	X-Failover-From     original provider, only when a failover occurred
//	X-Failover-Reason   what triggered it: 429 | 5xx | timeout | transport_error | context_overflow
//	X-Failover-Path     full chain of actual failover hops (comma separated)
func setRoutingHeaders(w http.ResponseWriter, selected resolvedProvider, servedBy, failoverFrom, failoverReason string, failoverPath []string) {
	if name := firstNonEmpty(servedBy, selected.Name); name != "" {
		w.Header().Set("X-Provider", boundedModelsProviderLabel(name))
	}
	if selected.Reason != "" {
		w.Header().Set("X-Route-Reason", selected.Reason)
	}
	if selected.Detail != "" {
		w.Header().Set("X-Route-Detail", selected.Detail)
	}
	if failoverFrom != "" {
		w.Header().Set("X-Failover-From", boundedModelsProviderLabel(failoverFrom))
	}
	if failoverReason != "" {
		w.Header().Set("X-Failover-Reason", failoverReason)
	}
	if len(failoverPath) > 0 {
		w.Header().Set("X-Failover-Path", strings.Join(failoverPath, ","))
	}
}
