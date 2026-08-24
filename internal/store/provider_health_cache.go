package store

import (
	"context"
	"time"
)

// Caching the provider health scores.
//
// ProviderHealthScores reads every request_logs row in a time window and aggregates them
// in Go, sorting each provider's latencies to take a P95. The routing layer calls it twice
// per request: once to score the model's candidates, once to record the chosen provider's
// score on the routing plan.
//
// That makes the cost of one request proportional to how many requests the gateway has
// served in the last fifteen minutes, which is proportional to throughput — so the work
// the database does per second grows with the square of the request rate. Measured on
// SQLite, one call takes 2.2ms over a thousand rows, 18.5ms over ten thousand, and 95ms
// over fifty thousand. Fifty thousand rows in a fifteen-minute window is about 56 requests
// per second, and at that rate every request was spending 190ms computing provider health
// before doing anything else.
//
// So it is cached — and unlike the provider, policy and quota caches, this one has no
// invalidation and must not grow one. Those cache what an operator wrote, and a write is a
// point in time that can clear them. This caches a statistic derived from traffic, which
// changes on every request; there is no edit to hook. The TTL is the whole mechanism.
//
// Three seconds of a fifteen-minute window is 0.3% of the data, so a cached score differs
// from a fresh one by an amount too small to change a routing decision — while turning
// per-request work proportional to traffic into one computation per TTL however busy the
// gateway is.
//
// The uncached ProviderHealthScores stays for the admin screens, where a window is chosen
// by the operator and the exact answer is the point.
type providerHealthCache struct {
	scores cachedValue[providerHealthSnapshot]
}

// providerHealthSnapshot records which window the scores were computed over, so a caller
// asking for a different one gets a fresh computation rather than the wrong answer.
type providerHealthSnapshot struct {
	window time.Duration
	scores []ProviderHealthScore
}

// ProviderHealthWindow returns the health scores over the trailing window, recomputing
// them at most once per cache interval. Callers on the request path should use this;
// callers that need the scores as of an exact instant should use ProviderHealthScores.
func (s *SQLStore) ProviderHealthWindow(ctx context.Context, window time.Duration) ([]ProviderHealthScore, error) {
	now := time.Now()
	if snap, ok := s.providerHealth.scores.get(now); ok && snap.window == window {
		return append([]ProviderHealthScore(nil), snap.scores...), nil
	}
	gen := s.providerHealth.scores.begin()
	scores, err := s.ProviderHealthScores(ctx, now.Add(-window))
	if err != nil {
		return nil, err
	}
	s.providerHealth.scores.putIfCurrent(
		providerHealthSnapshot{window: window, scores: append([]ProviderHealthScore(nil), scores...)}, gen, now)
	return scores, nil
}
