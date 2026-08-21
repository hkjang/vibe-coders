package proxy

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// Provider circuit breaker.
//
// Without it a dead upstream is re-dialled on every single request, and each of
// those dials burns the full provider timeout (UPSTREAM_TIMEOUT defaults to 10
// minutes) before failover even starts. Under load that exhausts gateway
// connections and makes one provider's outage look like a gateway outage.
//
// The breaker keeps per-provider failure state in memory and takes a provider out
// of the candidate list while it is known-bad:
//
//	closed    → normal; consecutive failures are counted
//	open      → skipped as a candidate until the cooldown elapses
//	half-open → cooldown elapsed; exactly one probe request is allowed through.
//	            Success closes the breaker, failure re-opens it.
//
// State is per gateway instance and deliberately not persisted: it describes live
// reachability, so a restart should re-probe rather than inherit a stale verdict.
type breakerPhase string

const (
	breakerClosed   breakerPhase = "closed"
	breakerOpen     breakerPhase = "open"
	breakerHalfOpen breakerPhase = "half_open"
)

const (
	defaultBreakerThreshold = 5
	defaultBreakerCooldown  = 30 * time.Second
)

type breakerState struct {
	failures    int
	phase       breakerPhase
	openedAt    time.Time
	probing     bool
	probeAt     time.Time
	lastReason  string
	lastFailure time.Time
	opens       int
}

type providerBreakers struct {
	mu     sync.Mutex
	states map[string]*breakerState
}

func newProviderBreakers() *providerBreakers {
	return &providerBreakers{states: map[string]*breakerState{}}
}

func (b *providerBreakers) state(name string) *breakerState {
	st, ok := b.states[name]
	if !ok {
		st = &breakerState{phase: breakerClosed}
		b.states[name] = st
	}
	return st
}

// allow reports whether a provider may be dialled now. An open breaker whose
// cooldown has elapsed moves to half-open and lets exactly one probe through;
// concurrent callers are refused until that probe reports back, so a recovering
// provider is not stampeded.
func (b *providerBreakers) allow(name string, threshold int, cooldown time.Duration, now time.Time) bool {
	if b == nil || name == "" {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state(name)
	switch st.phase {
	case breakerOpen:
		if now.Sub(st.openedAt) < cooldown {
			return false
		}
		st.phase = breakerHalfOpen
		st.probing = true
		st.probeAt = now
		return true
	case breakerHalfOpen:
		// A granted probe is not guaranteed to be dialled: candidates are filtered up
		// front, so an earlier provider answering first leaves this probe unused. Treat
		// a probe that never reported back within a cooldown as abandoned, otherwise the
		// breaker would stay half-open forever and the provider could never recover.
		if st.probing && now.Sub(st.probeAt) < cooldown {
			return false
		}
		st.probing = true
		st.probeAt = now
		return true
	default:
		return true
	}
}

// recordSuccess closes the breaker. Any success — including the half-open probe —
// clears the failure streak, because the streak is about consecutive failures.
func (b *providerBreakers) recordSuccess(name string) {
	if b == nil || name == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state(name)
	st.failures = 0
	st.phase = breakerClosed
	st.probing = false
	st.lastReason = ""
}

// recordFailure counts one failed dial. A failed half-open probe re-opens the
// breaker immediately rather than waiting for the threshold again — the provider
// has already proven it is still bad.
func (b *providerBreakers) recordFailure(name, reason string, threshold int, now time.Time) bool {
	if b == nil || name == "" {
		return false
	}
	if threshold <= 0 {
		threshold = defaultBreakerThreshold
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state(name)
	st.failures++
	st.lastReason = reason
	st.lastFailure = now
	wasOpen := st.phase == breakerOpen
	if st.phase == breakerHalfOpen || st.failures >= threshold {
		st.phase = breakerOpen
		st.openedAt = now
		st.probing = false
		if !wasOpen {
			st.opens++
			return true
		}
	}
	return false
}

// reset clears one provider (or all, when name is empty) back to closed. Operators
// need this after fixing a provider so they do not have to wait out the cooldown.
func (b *providerBreakers) reset(name string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if name == "" {
		b.states = map[string]*breakerState{}
		return
	}
	delete(b.states, name)
}

type breakerSnapshot struct {
	Provider       string `json:"provider"`
	Phase          string `json:"phase"`
	Failures       int    `json:"failures"`
	Opens          int    `json:"opens"`
	LastReason     string `json:"last_reason,omitempty"`
	LastFailureAt  string `json:"last_failure_at,omitempty"`
	OpenedAt       string `json:"opened_at,omitempty"`
	RetryInSeconds int    `json:"retry_in_seconds,omitempty"`
}

// snapshot renders the live state for the admin UI. Only providers the gateway has
// actually seen fail appear here; a healthy provider that has never failed has no
// entry, which reads as "nothing to report".
func (b *providerBreakers) snapshot(cooldown time.Duration, now time.Time) []breakerSnapshot {
	if b == nil {
		return []breakerSnapshot{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]breakerSnapshot, 0, len(b.states))
	for name, st := range b.states {
		if st.phase == breakerClosed && st.failures == 0 && st.opens == 0 {
			continue
		}
		snap := breakerSnapshot{
			Provider:   name,
			Phase:      string(st.phase),
			Failures:   st.failures,
			Opens:      st.opens,
			LastReason: st.lastReason,
		}
		if !st.lastFailure.IsZero() {
			snap.LastFailureAt = st.lastFailure.UTC().Format(time.RFC3339)
		}
		if st.phase == breakerOpen && !st.openedAt.IsZero() {
			snap.OpenedAt = st.openedAt.UTC().Format(time.RFC3339)
			if remaining := cooldown - now.Sub(st.openedAt); remaining > 0 {
				snap.RetryInSeconds = int(remaining.Seconds() + 0.5)
			}
		}
		out = append(out, snap)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Provider < out[j].Provider })
	return out
}

func (s *Server) breakerConfig() (enabled bool, threshold int, cooldown time.Duration) {
	up := s.cfg.Upstream
	threshold = up.BreakerThreshold
	if threshold <= 0 {
		threshold = defaultBreakerThreshold
	}
	cooldown = up.BreakerCooldown
	if cooldown <= 0 {
		cooldown = defaultBreakerCooldown
	}
	return up.BreakerEnabled, threshold, cooldown
}

// breakerCountsAsFailure decides which upstream outcomes damage a provider's
// reputation. It deliberately mirrors the failover triggers: a status the gateway
// would fail over on is also a status that says this provider cannot serve now.
// Client-side 4xx (bad key, unknown model) are excluded — they would fail the same
// way everywhere, so opening a breaker on them would take down a healthy provider.
func breakerCountsAsFailure(status int) bool {
	return statusFallbackAllowed(status)
}

// filterOpenBreakers drops providers whose breaker is open so a known-dead upstream
// is not dialled at all. It never returns an empty list: if every candidate is open,
// the original primary is kept as a forced probe. Refusing to call anyone would turn
// a recoverable provider outage into a self-inflicted total outage, and it would also
// prevent the breakers from ever observing a recovery.
func (s *Server) filterOpenBreakers(attempts []providerAttempt, threshold int, cooldown time.Duration, traceID string) []providerAttempt {
	if len(attempts) == 0 {
		return attempts
	}
	now := time.Now()
	kept := make([]providerAttempt, 0, len(attempts))
	skipped := make([]string, 0, len(attempts))
	for _, att := range attempts {
		if s.breakers.allow(att.provider.Name, threshold, cooldown, now) {
			kept = append(kept, att)
			continue
		}
		skipped = append(skipped, att.provider.Name)
	}
	if len(skipped) > 0 {
		slog.Info("provider breaker skipped candidates", "skipped", skipped, "remaining", len(kept), "trace_id", traceID)
	}
	if len(kept) == 0 {
		slog.Warn("all provider breakers open; probing primary anyway", "provider", attempts[0].provider.Name, "trace_id", traceID)
		return attempts[:1]
	}
	return kept
}

// noteBreakerFailure records a failed dial and logs the transition when the breaker
// opens, so an operator can see in the log exactly when a provider was taken out.
func (s *Server) noteBreakerFailure(name, reason string, threshold int, traceID string) {
	if s.breakers.recordFailure(name, reason, threshold, time.Now()) {
		_, _, cooldown := s.breakerConfig()
		slog.Warn("provider breaker opened", "provider", name, "reason", reason, "cooldown", cooldown.String(), "trace_id", traceID)
		s.notifyMattermost(context.Background(), "provider",
			"Provider 회로 차단: "+name+" ("+reason+") — "+cooldown.String()+" 동안 폴백 후보에서 제외됩니다")
	}
}

// providerAttempt is one dial target in dialUpstream's ordered candidate list.
type providerAttempt struct {
	provider resolvedProvider
}
