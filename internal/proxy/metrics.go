package proxy

import (
	"fmt"
	"strings"
	"sync/atomic"

	"vibe-coders/internal/store"
)

type Metrics struct {
	requests           atomic.Uint64
	streams            atomic.Uint64
	upstreamError      atomic.Uint64
	quotaBlocked       atomic.Uint64
	killSwitched       atomic.Uint64
	alertsFired        atomic.Uint64
	alertsDelivered    atomic.Uint64
	cacheHits          atomic.Uint64
	cacheMisses        atomic.Uint64
	failovers          atomic.Uint64
	llmEvaluations     atomic.Uint64
	llmEvalFailures    atomic.Uint64
	mcpToolCalls       atomic.Uint64
	mcpToolErrors      atomic.Uint64
	mcpBlocked         atomic.Uint64
	routingOverride    atomic.Uint64
	knowledgeExpand    atomic.Uint64 // requests that expanded ≥1 knowledge snippet
	knowledgeTokens    atomic.Uint64 // estimated tokens injected via knowledge expansion
	costGuardBlock     atomic.Uint64 // requests blocked by the pre-call cost guard
	promptInjection    atomic.Uint64 // requests where prompt-injection patterns were detected
	t2sRequests        atomic.Uint64 // Text2SQL virtual-model requests handled
	t2sCacheHit        atomic.Uint64 // Text2SQL preview cache hits
	t2sRiskBlocked     atomic.Uint64 // Text2SQL requests blocked by cumulative-risk enforcement
	t2sChallengeVeto   atomic.Uint64 // Text2SQL execute vetoed by self-challenge review
	t2sShadowEval      atomic.Uint64 // Text2SQL shadow model evaluations performed
	skillBlocked       atomic.Uint64 // requests blocked by Skill policy enforcement
	modelSunsetRewrite atomic.Uint64 // requests rewritten to a replacement model after sunset
	modelSunsetBlock   atomic.Uint64 // requests blocked because a model is retired with no replacement
	limitsClamped      atomic.Uint64 // requests whose max output tokens were clamped/injected
	limitsRejected     atomic.Uint64 // requests rejected by request-size / message-count guards
	latency            *LatencyDigest
	firstChunk         *LatencyDigest
}

func newMetrics() *Metrics {
	return &Metrics{latency: newLatencyDigest(), firstChunk: newLatencyDigest()}
}

func (m *Metrics) ObserveLatency(ms int64) {
	if m.latency != nil {
		m.latency.Observe(ms)
	}
}

func (m *Metrics) ObserveFirstChunk(ms int64) {
	if m.firstChunk != nil {
		m.firstChunk.Observe(ms)
	}
}

func (m *Metrics) LatencyQuantiles() map[string]int64 {
	if m.latency == nil {
		return map[string]int64{}
	}
	q := m.latency.Quantiles(0.5, 0.95, 0.99)
	return map[string]int64{"p50": q[0], "p95": q[1], "p99": q[2]}
}

func (m *Metrics) FirstChunkQuantiles() map[string]int64 {
	if m.firstChunk == nil {
		return map[string]int64{}
	}
	q := m.firstChunk.Quantiles(0.5, 0.95, 0.99)
	return map[string]int64{"p50": q[0], "p95": q[1], "p99": q[2]}
}

func (m *Metrics) IncRequest(stream bool) {
	m.requests.Add(1)
	if stream {
		m.streams.Add(1)
	}
}

func (m *Metrics) IncUpstreamError() {
	m.upstreamError.Add(1)
}

// ObserveToolInvocations counts MCP/tool calls and tool-result errors for metrics.
func (m *Metrics) ObserveToolInvocations(tools []store.ToolInvocation) {
	for _, t := range tools {
		if t.Source == "call" {
			m.mcpToolCalls.Add(1)
		}
		if t.IsError {
			m.mcpToolErrors.Add(1)
		}
	}
}

func (m *Metrics) IncQuotaBlock() {
	m.quotaBlocked.Add(1)
}

func (m *Metrics) IncKillSwitch() {
	m.killSwitched.Add(1)
}

func (m *Metrics) IncAlertFired() {
	m.alertsFired.Add(1)
}

func (m *Metrics) IncAlertDelivered() {
	m.alertsDelivered.Add(1)
}

func (m *Metrics) IncCacheHit()        { m.cacheHits.Add(1) }
func (m *Metrics) IncCacheMiss()       { m.cacheMisses.Add(1) }
func (m *Metrics) IncFailover()        { m.failovers.Add(1) }
func (m *Metrics) IncMCPBlocked()      { m.mcpBlocked.Add(1) }
func (m *Metrics) IncRoutingOverride() { m.routingOverride.Add(1) }
func (m *Metrics) AddKnowledgeExpansion(tokens int) {
	m.knowledgeExpand.Add(1)
	if tokens > 0 {
		m.knowledgeTokens.Add(uint64(tokens))
	}
}
func (m *Metrics) IncCostGuardBlock()        { m.costGuardBlock.Add(1) }
func (m *Metrics) IncPromptInjection()       { m.promptInjection.Add(1) }
func (m *Metrics) IncText2SQLRequest()       { m.t2sRequests.Add(1) }
func (m *Metrics) IncText2SQLCacheHit()      { m.t2sCacheHit.Add(1) }
func (m *Metrics) IncText2SQLRiskBlocked()   { m.t2sRiskBlocked.Add(1) }
func (m *Metrics) IncText2SQLChallengeVeto() { m.t2sChallengeVeto.Add(1) }
func (m *Metrics) IncText2SQLShadowEval()    { m.t2sShadowEval.Add(1) }
func (m *Metrics) IncSkillBlocked()          { m.skillBlocked.Add(1) }
func (m *Metrics) IncModelSunsetRewrite()    { m.modelSunsetRewrite.Add(1) }
func (m *Metrics) IncModelSunsetBlock()      { m.modelSunsetBlock.Add(1) }
func (m *Metrics) IncLimitsClamped()         { m.limitsClamped.Add(1) }
func (m *Metrics) IncLimitsRejected()        { m.limitsRejected.Add(1) }

func (m *Metrics) ObserveLLMEvaluations(evaluations []store.LLMEvaluation) {
	for _, evaluation := range evaluations {
		m.llmEvaluations.Add(1)
		if !evaluation.Passed {
			m.llmEvalFailures.Add(1)
		}
	}
}

func (m *Metrics) Prometheus(queueDepth int, logDropped uint64, logWritten uint64) string {
	lines := []string{
		"# HELP proxy_requests_total Total proxied API requests.",
		"# TYPE proxy_requests_total counter",
		fmt.Sprintf("proxy_requests_total %d", m.requests.Load()),
		"# HELP proxy_stream_requests_total Total streaming API requests.",
		"# TYPE proxy_stream_requests_total counter",
		fmt.Sprintf("proxy_stream_requests_total %d", m.streams.Load()),
		"# HELP proxy_upstream_errors_total Total upstream request errors.",
		"# TYPE proxy_upstream_errors_total counter",
		fmt.Sprintf("proxy_upstream_errors_total %d", m.upstreamError.Load()),
		"# HELP proxy_quota_blocked_total Total requests blocked by quota policy.",
		"# TYPE proxy_quota_blocked_total counter",
		fmt.Sprintf("proxy_quota_blocked_total %d", m.quotaBlocked.Load()),
		"# HELP proxy_kill_switch_blocked_total Requests blocked by the global kill switch.",
		"# TYPE proxy_kill_switch_blocked_total counter",
		fmt.Sprintf("proxy_kill_switch_blocked_total %d", m.killSwitched.Load()),
		"# HELP proxy_alerts_fired_total Alert rule firings.",
		"# TYPE proxy_alerts_fired_total counter",
		fmt.Sprintf("proxy_alerts_fired_total %d", m.alertsFired.Load()),
		"# HELP proxy_alerts_delivered_total Alert webhook deliveries that succeeded.",
		"# TYPE proxy_alerts_delivered_total counter",
		fmt.Sprintf("proxy_alerts_delivered_total %d", m.alertsDelivered.Load()),
		"# HELP proxy_embedding_cache_hits_total Embedding requests served from the cache.",
		"# TYPE proxy_embedding_cache_hits_total counter",
		fmt.Sprintf("proxy_embedding_cache_hits_total %d", m.cacheHits.Load()),
		"# HELP proxy_embedding_cache_misses_total Embedding requests that bypassed the cache.",
		"# TYPE proxy_embedding_cache_misses_total counter",
		fmt.Sprintf("proxy_embedding_cache_misses_total %d", m.cacheMisses.Load()),
		"# HELP proxy_failover_total Times a request fell back to an alternate provider.",
		"# TYPE proxy_failover_total counter",
		fmt.Sprintf("proxy_failover_total %d", m.failovers.Load()),
		"# HELP proxy_llm_evaluations_total Total LLM evaluations observed by this process.",
		"# TYPE proxy_llm_evaluations_total counter",
		fmt.Sprintf("proxy_llm_evaluations_total %d", m.llmEvaluations.Load()),
		"# HELP proxy_llm_evaluation_failures_total Total failed LLM evaluations observed by this process.",
		"# TYPE proxy_llm_evaluation_failures_total counter",
		fmt.Sprintf("proxy_llm_evaluation_failures_total %d", m.llmEvalFailures.Load()),
		"# HELP proxy_mcp_tool_calls_total Total MCP/tool calls observed in responses.",
		"# TYPE proxy_mcp_tool_calls_total counter",
		fmt.Sprintf("proxy_mcp_tool_calls_total %d", m.mcpToolCalls.Load()),
		"# HELP proxy_mcp_tool_errors_total Total tool-result errors observed in requests.",
		"# TYPE proxy_mcp_tool_errors_total counter",
		fmt.Sprintf("proxy_mcp_tool_errors_total %d", m.mcpToolErrors.Load()),
		"# HELP proxy_mcp_blocked_total Requests blocked by MCP server policy.",
		"# TYPE proxy_mcp_blocked_total counter",
		fmt.Sprintf("proxy_mcp_blocked_total %d", m.mcpBlocked.Load()),
		"# HELP proxy_routing_overrides_total Requests whose model was changed by a complexity routing rule.",
		"# TYPE proxy_routing_overrides_total counter",
		fmt.Sprintf("proxy_routing_overrides_total %d", m.routingOverride.Load()),
		"# HELP proxy_knowledge_expansions_total Requests that expanded one or more knowledge snippets.",
		"# TYPE proxy_knowledge_expansions_total counter",
		fmt.Sprintf("proxy_knowledge_expansions_total %d", m.knowledgeExpand.Load()),
		"# HELP proxy_knowledge_tokens_total Estimated tokens injected via knowledge expansion.",
		"# TYPE proxy_knowledge_tokens_total counter",
		fmt.Sprintf("proxy_knowledge_tokens_total %d", m.knowledgeTokens.Load()),
		"# HELP proxy_cost_guard_blocked_total Requests blocked by the pre-call cost guard.",
		"# TYPE proxy_cost_guard_blocked_total counter",
		fmt.Sprintf("proxy_cost_guard_blocked_total %d", m.costGuardBlock.Load()),
		"# HELP proxy_prompt_injection_total Requests where prompt-injection patterns were detected.",
		"# TYPE proxy_prompt_injection_total counter",
		fmt.Sprintf("proxy_prompt_injection_total %d", m.promptInjection.Load()),
		"# HELP proxy_text2sql_requests_total Text2SQL virtual-model requests handled.",
		"# TYPE proxy_text2sql_requests_total counter",
		fmt.Sprintf("proxy_text2sql_requests_total %d", m.t2sRequests.Load()),
		"# HELP proxy_text2sql_cache_hits_total Text2SQL preview cache hits.",
		"# TYPE proxy_text2sql_cache_hits_total counter",
		fmt.Sprintf("proxy_text2sql_cache_hits_total %d", m.t2sCacheHit.Load()),
		"# HELP proxy_text2sql_risk_blocked_total Text2SQL requests blocked by cumulative-risk enforcement.",
		"# TYPE proxy_text2sql_risk_blocked_total counter",
		fmt.Sprintf("proxy_text2sql_risk_blocked_total %d", m.t2sRiskBlocked.Load()),
		"# HELP proxy_text2sql_challenge_veto_total Text2SQL executions vetoed by self-challenge review.",
		"# TYPE proxy_text2sql_challenge_veto_total counter",
		fmt.Sprintf("proxy_text2sql_challenge_veto_total %d", m.t2sChallengeVeto.Load()),
		"# HELP proxy_text2sql_shadow_evals_total Text2SQL shadow model evaluations performed.",
		"# TYPE proxy_text2sql_shadow_evals_total counter",
		fmt.Sprintf("proxy_text2sql_shadow_evals_total %d", m.t2sShadowEval.Load()),
		"# HELP proxy_skill_blocked_total Requests blocked by Skill policy enforcement.",
		"# TYPE proxy_skill_blocked_total counter",
		fmt.Sprintf("proxy_skill_blocked_total %d", m.skillBlocked.Load()),
		"# HELP proxy_model_sunset_rewrites_total Requests rewritten to a replacement model after sunset.",
		"# TYPE proxy_model_sunset_rewrites_total counter",
		fmt.Sprintf("proxy_model_sunset_rewrites_total %d", m.modelSunsetRewrite.Load()),
		"# HELP proxy_model_sunset_blocked_total Requests blocked because a model is retired with no replacement.",
		"# TYPE proxy_model_sunset_blocked_total counter",
		fmt.Sprintf("proxy_model_sunset_blocked_total %d", m.modelSunsetBlock.Load()),
		"# HELP proxy_limits_clamped_total Requests whose output-token ceiling was clamped or injected.",
		"# TYPE proxy_limits_clamped_total counter",
		fmt.Sprintf("proxy_limits_clamped_total %d", m.limitsClamped.Load()),
		"# HELP proxy_limits_rejected_total Requests rejected by request-size or message-count guards.",
		"# TYPE proxy_limits_rejected_total counter",
		fmt.Sprintf("proxy_limits_rejected_total %d", m.limitsRejected.Load()),
		"# HELP proxy_log_queue_depth Current async log queue depth.",
		"# TYPE proxy_log_queue_depth gauge",
		fmt.Sprintf("proxy_log_queue_depth %d", queueDepth),
		"# HELP proxy_log_events_dropped_total Audit log events dropped because the queue was full.",
		"# TYPE proxy_log_events_dropped_total counter",
		fmt.Sprintf("proxy_log_events_dropped_total %d", logDropped),
		"# HELP proxy_log_events_written_total Audit log events written to the database.",
		"# TYPE proxy_log_events_written_total counter",
		fmt.Sprintf("proxy_log_events_written_total %d", logWritten),
	}
	out := strings.Join(lines, "\n") + "\n"
	if m.latency != nil {
		out += m.latency.PrometheusHistogram()
	}
	if m.firstChunk != nil {
		out += m.firstChunk.PrometheusHistogramFor("proxy_first_chunk_duration_ms", "First upstream response chunk latency in milliseconds (last 4096 samples).")
	}
	return out
}
