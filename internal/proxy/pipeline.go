package proxy

import (
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
//	Auth → Quota → Routing → Skill → Deprecation → Governance → Cache → Cost → Upstream
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

	routeDecision routingDecision
	routingPlan   *intelligentRoutingPlan
	meta          store.LogRecord

	estimatedCostKRW float64

	chatCacheKey    string
	chatCacheable   bool
	chatSemanticVec []float64

	skillName    string
	skillVersion string
	skillTools   string
}

// pipelineSteps returns the ordered request pipeline. The order is the contract:
// authentication first, then quota enforcement, intelligent routing, governance
// (policy/secret/MCP/knowledge), response caches, pre-call cost guard, and finally
// the upstream dial + response relay.
func (rc *requestPipeline) steps() []PipelineStep {
	return []PipelineStep{
		stepFunc{"auth", (*requestPipeline).stepAuth},
		stepFunc{"quota", (*requestPipeline).stepQuota},
		stepFunc{"routing", (*requestPipeline).stepRouting},
		stepFunc{"skill", (*requestPipeline).stepSkill},
		stepFunc{"deprecation", (*requestPipeline).stepDeprecation},
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
	} else {
		var ok bool
		rc.apiKeyID, rc.authCtx, ok = s.authenticateProxyContext(r)
		if !ok {
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
	if decision, err := s.checkQuotas(r.Context(), rc.apiKeyID, clientAddr); err != nil {
		slog.Warn("quota check failed", "error", err)
	} else if !decision.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(quotaRetryAfterSeconds(decision.PeriodEnd)))
		w.Header().Set("X-Quota-Scope", quotaHeaderTag(decision))
		w.Header().Set("X-Quota-Tokens", strconv.FormatInt(decision.Tokens, 10))
		w.Header().Set("X-Quota-Cost-KRW", formatKRW(decision.CostKRW))
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

	var body []byte
	var err error
	if r.Body != nil {
		body, err = io.ReadAll(r.Body)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
			return false
		}
	}
	rc.body = body

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

	meta := s.auditRequest(r.URL.Path, body, rc.apiKeyID, traceID, r)
	if routingPlan != nil {
		meta.Request.Complexity = routingPlan.Complexity.Score
		if routingPlan.RequestedModel != "" && routingPlan.RequestedModel != meta.Request.Model {
			meta.Request.RequestedModel = routingPlan.RequestedModel
		}
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
	}
	if routeDecision.Applied {
		meta.Request.RequestedModel = routeDecision.OriginalModel
		s.metrics.IncRoutingOverride()
	}

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
		rc.body, blocked = s.enforceOpenAIGovernance(w, r, &rc.meta, rc.body, rc.authCtx, rc.routingPlan, 0, true, "request")
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
		if served := s.serveEmbeddingFromCache(r.Context(), w, r, rc.body, rc.meta, rc.traceID); served {
			return false
		}
	}

	// Chat response cache — opt-in, only for deterministic (temp 0 / seed) requests.
	rc.chatCacheKey, rc.chatCacheable = s.chatCacheEligible(r, rc.body)
	if rc.chatCacheable {
		if served := s.serveChatFromCache(r.Context(), w, rc.chatCacheKey, rc.meta, rc.traceID); served {
			return false
		}
		// Exact miss → try the embedding-based semantic cache (opt-in). The query vector
		// is kept on rc so a fresh upstream response is stored under it.
		if vec, served := s.serveChatSemantic(r.Context(), w, r, rc.body, rc.meta, rc.traceID); served {
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
		rc.body, blocked = s.enforceOpenAIGovernance(w, r, &rc.meta, rc.body, rc.authCtx, rc.routingPlan, rc.estimatedCostKRW, false, "cost")
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

	provider, err := s.selectProviderForced(r.Context(), r, meta.Request.Model, rc.routeDecision.TargetProvider)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "provider_unavailable")
		return false
	}
	if rc.authCtx != nil && !listAllows(provider.Name, rc.authCtx.AllowedProviders, rc.authCtx.DeniedProviders) {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "model_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "provider:" + provider.Name, CreatedAt: time.Now().UTC()})
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
	if r.Method == http.MethodPost {
		var blocked bool
		body, blocked = s.enforceOpenAIGovernance(w, r, &meta, body, rc.authCtx, routingPlan, rc.estimatedCostKRW, false, "provider")
		if blocked {
			return false
		}
	}

	// Identify failover candidates: only when the client did NOT explicitly pin a provider.
	failoverCandidates := []string{}
	fallbackAllowed := routingPlan == nil || !riskDisablesFallback(routingPlan.Risk)
	if fallbackAllowed && strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) == "" && strings.TrimSpace(r.URL.Query().Get("provider")) == "" {
		if cands, _ := s.providersForModel(r.Context(), meta.Request.Model); len(cands) > 1 {
			for _, name := range cands {
				if name != provider.Name {
					failoverCandidates = append(failoverCandidates, name)
				}
			}
		}
	}

	start := time.Now()
	resp, resolvedName, failoverFrom, failoverReason, failoverPath, finalBody, finalModel, err := s.dialUpstream(r.Context(), r, body, provider, traceID, failoverCandidates)
	if finalBody != nil {
		body = finalBody
	}
	if finalModel != "" && finalModel != meta.Request.Model {
		meta.Request.Model = finalModel
		if routingPlan != nil {
			routingPlan.SelectedModel = finalModel
		}
	}
	if err != nil {
		s.metrics.IncUpstreamError()
		status := statusForUpstreamError(err)
		meta.Request.StatusCode = status
		meta.Request.LatencyMS = time.Since(start).Milliseconds()
		meta.Request.Error = err.Error()
		meta.Request.FallbackReason = err.Error()
		if routingPlan != nil {
			routingPlan.FallbackPath = append(routingPlan.FallbackPath, failoverPath...)
			meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
		}
		meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{})
		s.metrics.ObserveLLMEvaluations(meta.Evaluations)
		rc.recordSkillRun(rc.skillName, rc.skillVersion, "error", meta.Request.Model, 0, meta.Request.LatencyMS)
		s.enqueue(meta)
		s.notifyMattermost(r.Context(), "provider", "Provider 장애: "+meta.Request.Provider+" 요청 실패 ("+err.Error()+")")
		writeOpenAIError(w, status, "upstream request failed: "+err.Error(), "server_error", "upstream_request_failed")
		return false
	}
	defer resp.Body.Close()
	if failoverFrom != "" {
		s.metrics.IncFailover()
		w.Header().Set("X-Failover-From", failoverFrom)
		meta.Request.Failover = true
		meta.Request.FallbackFrom = failoverFrom
		meta.Request.FallbackReason = failoverReason
	}
	if resolvedName != "" {
		meta.Request.Provider = resolvedName
	}
	if routingPlan != nil {
		routingPlan.SelectedProvider = meta.Request.Provider
		if len(failoverPath) > 0 {
			routingPlan.FallbackPath = append(routingPlan.FallbackPath, failoverPath...)
		}
		meta.Routing = routingPlan.toStore(meta.Request.ID, traceID, meta.Request.Provider)
	}

	stream := meta.Request.Stream || strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	s.metrics.IncRequest(stream)
	meta.Request.Stream = stream
	meta.Request.StatusCode = resp.StatusCode

	copyDownstreamHeaders(w.Header(), resp.Header)
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(resp.StatusCode)

	captureForCache := !stream && r.URL.Path == "/v1/embeddings" && s.cacheConf().EmbeddingEnabled
	captureForChatCache := !stream && rc.chatCacheable && resp.StatusCode == http.StatusOK
	captureLimit := s.cfg.Logging.ResponseMaxBytes
	if (captureForCache || captureForChatCache) && s.cacheConf().EmbeddingMaxBytes > captureLimit {
		captureLimit = s.cacheConf().EmbeddingMaxBytes
	}
	analyzer := NewResponseAnalyzer(stream, captureForCache || captureForChatCache || s.cfg.Logging.ResponseText, captureLimit)
	firstChunkMS, firstChunkSeen, copyErr := s.copyResponse(w, resp.Body, analyzer, stream, start)
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
		s.maybeStoreEmbeddingCache(r.Context(), body, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForChatCache && analysis.Text != "" {
		s.maybeStoreChatCache(r.Context(), rc.chatCacheKey, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
		s.maybeStoreChatSemantic(r.Context(), rc.body, rc.chatSemanticVec, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForCache || captureForChatCache {
		s.metrics.IncCacheMiss()
	}
	// Clear captured text so we don't accidentally persist it when LOG_RESPONSE_TEXT=false.
	if (captureForCache || captureForChatCache) && !s.cfg.Logging.ResponseText {
		analysis.Text = ""
	}
	meta.Response = &store.ResponseLog{
		ID:                   newID("resp"),
		RequestID:            meta.Request.ID,
		StatusCode:           resp.StatusCode,
		FinishReason:         analysis.FinishReason,
		ResponseHash:         analysis.Hash,
		ResponseTextOptional: analysis.Text,
		CreatedAt:            time.Now().UTC(),
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
	s.enqueue(meta)
	return true
}
