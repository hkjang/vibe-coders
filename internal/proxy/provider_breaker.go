package proxy

import (
	"context"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
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
// recordSuccessAfterOpen closes the breaker and reports whether it had been open or
// probing, which is the only case where peers need to hear about the recovery.
func (b *providerBreakers) recordSuccessAfterOpen(name string) bool {
	if b == nil || name == "" {
		return false
	}
	b.mu.Lock()
	wasOpen := false
	if st, ok := b.states[name]; ok {
		wasOpen = st.phase != breakerClosed
	}
	b.mu.Unlock()
	b.recordSuccess(name)
	return wasOpen
}

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

// resetExisting clears one provider only when it is a real internal breaker key.
// Admin callers use this instead of echoing and "resetting" arbitrary input that was
// never present in the breaker map.
func (b *providerBreakers) resetExisting(name string) bool {
	if b == nil || name == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.states[name]; !ok {
		return false
	}
	delete(b.states, name)
	return true
}

func (b *providerBreakers) has(name string) bool {
	if b == nil || name == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.states[name]
	return ok
}

// rawNames is an internal-only diagnostic view. The public snapshot deliberately
// redacts unsafe legacy provider names and must never replace raw internal keys.
func (b *providerBreakers) rawNames() []string {
	if b == nil {
		return []string{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	names := make([]string, 0, len(b.states))
	for name := range b.states {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
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
			Provider:   boundedModelsProviderLabel(name),
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
	up := s.upstreamConf()
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
		skipped = append(skipped, boundedModelsProviderLabel(att.provider.Name))
	}
	if len(skipped) > 0 {
		slog.Info("provider breaker skipped candidates", "skipped", skipped, "remaining", len(kept), "trace_id", traceID)
	}
	if len(kept) == 0 {
		slog.Warn("all provider breakers open; probing primary anyway", "provider", boundedModelsProviderLabel(attempts[0].provider.Name), "trace_id", traceID)
		return attempts[:1]
	}
	return kept
}

// noteBreakerFailure records a failed dial and logs the transition when the breaker
// opens, so an operator can see in the log exactly when a provider was taken out.
func (s *Server) noteBreakerFailure(name, reason string, threshold int, traceID string) {
	now := time.Now()
	if s.breakers.recordFailure(name, reason, threshold, now) {
		_, _, cooldown := s.breakerConfig()
		providerLabel := boundedModelsProviderLabel(name)
		slog.Warn("provider breaker opened", "provider", providerLabel, "reason", reason, "cooldown", cooldown.String(), "trace_id", traceID)
		// Tell the other instances now, so they skip this provider instead of each
		// spending their own threshold of failures rediscovering it.
		s.publishBreakerState(name, reason, now)
		s.notifyMattermost(context.Background(), "provider",
			"Provider 회로 차단: "+providerLabel+" ("+reason+") — "+cooldown.String()+" 동안 폴백 후보에서 제외됩니다")
	}
}

// noteBreakerSuccess closes the breaker locally and, when it had been open, announces
// the recovery so peers stop skipping the provider.
func (s *Server) noteBreakerSuccess(name string) {
	if s.breakers.recordSuccessAfterOpen(name) {
		s.clearSharedBreakerState(name)
	}
}

// providerAttempt is one dial target in dialUpstream's ordered candidate list.
type providerAttempt struct {
	provider resolvedProvider
}

// peek reports whether a provider is currently dialable WITHOUT consuming the
// half-open probe slot. The load balancer uses it to avoid steering traffic at a
// tripped provider; allow() stays reserved for the dial path, which is what should
// actually spend the single probe.
func (b *providerBreakers) peek(name string, threshold int, cooldown time.Duration, now time.Time) bool {
	if b == nil || name == "" {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	st, ok := b.states[name]
	if !ok {
		return true
	}
	switch st.phase {
	case breakerOpen:
		return now.Sub(st.openedAt) >= cooldown
	case breakerHalfOpen:
		return !st.probing || now.Sub(st.probeAt) >= cooldown
	default:
		return true
	}
}

// Health-based demotion.
//
// The circuit breaker removes a provider that is failing outright. It says nothing
// about one that is merely degraded — slow, or returning the occasional 5xx — which
// still answers and so keeps its place at the front of the queue, spending a real
// request and its latency before failing over.
//
// Provider health scores already measure exactly that, but until now they were
// computed and displayed without influencing a single routing decision.
//
// Demotion, not re-sorting: priority is the operator's declared intent and must keep
// deciding the order. A provider below the threshold is moved to the BACK of the
// candidate list, preserving relative order within the healthy and demoted halves. It
// is never dropped — health is a lagging average, and a provider that has recovered
// has to be tried to be seen recovering.
func (s *Server) healthDemoteThreshold() int {
	t := s.upstreamConf().HealthDemoteThreshold
	if t < 0 {
		return 0
	}
	if t > 100 {
		return 100
	}
	return t
}

// demoteUnhealthyCandidates returns the candidates reordered so that any provider
// scoring below the threshold is tried last, along with the names it demoted so the
// decision can be reported rather than silently applied.
func (s *Server) demoteUnhealthyCandidates(ctx context.Context, candidates []string) ([]string, []string) {
	threshold := s.healthDemoteThreshold()
	if threshold <= 0 || len(candidates) < 2 {
		return candidates, nil
	}
	health := s.providerHealthMap(ctx)
	healthy := make([]string, 0, len(candidates))
	demoted := make([]string, 0, len(candidates))
	for _, name := range candidates {
		score, seen := health[name]
		// No traffic in the window means no evidence of degradation; treat as healthy
		// so a fresh or idle provider is not demoted for lack of a track record.
		if seen && score.Score < threshold {
			demoted = append(demoted, name)
			continue
		}
		healthy = append(healthy, name)
	}
	if len(demoted) == 0 {
		return candidates, nil
	}
	return append(healthy, demoted...), demoted
}

// Cross-instance breaker sharing.
//
// Each instance otherwise rediscovers a dead provider independently, paying its own
// BreakerThreshold failures for something a peer already established. Publishing
// transitions through the shared store lets the others skip ahead.
//
// The design deliberately ADOPTS a peer's open state rather than special-casing it in
// allow()/peek(): once adopted, the existing cooldown, half-open probe and recovery
// logic all apply unchanged, so a remotely-reported outage recovers by exactly the same
// path as a locally-observed one.
//
// That also bounds the blast radius of a wrong verdict. An instance with, say, a bad
// network path to one provider can make its peers skip that provider — but only until
// the cooldown elapses, at which point each peer runs its own probe, and a successful
// probe clears the shared row for everyone. A stale row from an instance that died is
// ignored outright via its updated_at.
func (s *Server) breakerSharingEnabled() bool {
	return s.cfg.Upstream.BreakerShared && s.db != nil
}

// publishBreakerState reports a local transition. Failures are logged and dropped: the
// shared row is an optimisation, and losing it must never affect serving traffic.
func (s *Server) publishBreakerState(provider, reason string, openedAt time.Time) {
	if !s.breakerSharingEnabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.db.PublishProviderBreaker(ctx, store.ProviderBreakerState{
		Provider: provider, Phase: string(breakerOpen), Reason: reason,
		Instance: s.instanceID, OpenedAt: openedAt, UpdatedAt: time.Now().UTC(),
	}); err != nil {
		slog.Warn("publish breaker state failed", "provider", boundedModelsProviderLabel(provider), "code", "breaker_state_publish_failed")
	}
}

func (s *Server) clearSharedBreakerState(provider string) error {
	if !s.breakerSharingEnabled() {
		return nil
	}
	return s.clearSharedBreakerStateForAdmin(provider)
}

// clearSharedBreakerStateForAdmin removes persisted state regardless of the current
// sharing toggle. An operator reset must also clear stale rows left before sharing was
// disabled, while normal request success remains opt-in through clearSharedBreakerState.
func (s *Server) clearSharedBreakerStateForAdmin(provider string) error {
	if s.db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.db.ClearProviderBreaker(ctx, provider); err != nil {
		slog.Warn("clear shared breaker state failed", "provider", boundedModelsProviderLabel(provider), "code", "breaker_state_clear_failed")
		return err
	}
	return nil
}

func (s *Server) clearAllSharedBreakerStates() error {
	if s.db == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.db.ClearAllProviderBreakers(ctx); err != nil {
		slog.Warn("clear all shared breaker states failed", "code", "breaker_state_clear_all_failed")
		return err
	}
	return nil
}

// adoptRemoteBreakers copies peers' open breakers into local state. Only rows fresher
// than one cooldown are honoured, and only for providers this instance currently
// considers healthy — a local verdict is first-hand evidence and outranks a peer's.
func (b *providerBreakers) adoptRemote(states []store.ProviderBreakerState, cooldown time.Time) []string {
	if b == nil || len(states) == 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	adopted := []string{}
	for _, remote := range states {
		st := b.state(remote.Provider)
		if st.phase != breakerClosed {
			continue // already open or probing locally
		}
		if remote.OpenedAt.Before(cooldown) {
			continue // the peer's report has already aged out
		}
		st.phase = breakerOpen
		st.openedAt = remote.OpenedAt
		st.lastReason = remote.Reason + " (peer " + remote.Instance + ")"
		st.probing = false
		adopted = append(adopted, remote.Provider)
	}
	return adopted
}

// breakerSyncLoop polls peers' breaker state. Only transitions are written, so this
// read is the entire ongoing cost of sharing.
func (s *Server) breakerSyncLoop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_, _, cooldown := s.breakerConfig()
			queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			states, err := s.db.ListOpenProviderBreakers(queryCtx, time.Now().UTC().Add(-2*cooldown))
			cancel()
			if err != nil {
				slog.Warn("breaker sync failed", "error", err)
				continue
			}
			if adopted := s.breakers.adoptRemote(states, time.Now().Add(-cooldown)); len(adopted) > 0 {
				labels := make([]string, 0, len(adopted))
				for _, provider := range adopted {
					labels = append(labels, boundedModelsProviderLabel(provider))
				}
				slog.Info("adopted peer breaker state", "providers", labels, "instance", s.instanceID)
			}
		}
	}
}

func (s *Server) startBreakerSync() {
	if !s.breakerSharingEnabled() {
		return
	}
	interval := s.cfg.Upstream.BreakerSyncInterval
	if interval <= 0 {
		interval = 3 * time.Second
	}
	go s.breakerSyncLoop(s.db.LifecycleContext(), interval)
	slog.Info("provider breaker sharing enabled", "instance", s.instanceID, "interval", interval.String())
}

// instanceIdentity labels this process in shared breaker rows. Hostname alone collides
// when several instances share a host (containers, local testing), so a short random
// suffix is appended; it only has to be distinguishable, not durable.
func instanceIdentity() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "gateway"
	}
	return host + "/" + newID("i")[len("i_"):][:6]
}
