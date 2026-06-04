package proxy

import (
	"fmt"
	"strings"
	"sync/atomic"

	"vibe-coders/internal/store"
)

type Metrics struct {
	requests        atomic.Uint64
	streams         atomic.Uint64
	upstreamError   atomic.Uint64
	quotaBlocked    atomic.Uint64
	killSwitched    atomic.Uint64
	alertsFired     atomic.Uint64
	alertsDelivered atomic.Uint64
	cacheHits       atomic.Uint64
	cacheMisses     atomic.Uint64
	failovers       atomic.Uint64
	llmEvaluations  atomic.Uint64
	llmEvalFailures atomic.Uint64
	latency         *LatencyDigest
	firstChunk      *LatencyDigest
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

func (m *Metrics) IncCacheHit()  { m.cacheHits.Add(1) }
func (m *Metrics) IncCacheMiss() { m.cacheMisses.Add(1) }
func (m *Metrics) IncFailover()  { m.failovers.Add(1) }

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
