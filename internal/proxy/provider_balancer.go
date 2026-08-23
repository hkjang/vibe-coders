package proxy

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Provider load balancing.
//
// Model-pattern routing resolves to the FIRST matching provider by name, so three
// nodes all serving "core-h200" send every request to the alphabetically first one
// and the other two act purely as failover spares. This turns that same candidate
// set into an active-active pool.
//
// Two selection modes:
//
//	first        the historical behaviour — always the first matching provider
//	round_robin  rotate through the matching providers per model
//
// Round robin alone is wrong for agentic clients. Tools like qwen code hold a long
// conversation and resend a growing prefix every turn; bouncing those turns across
// vLLM nodes throws away the prefix/KV cache on each one and can change behaviour
// mid-session. So a session, once it has been served by a provider, stays on that
// provider (sticky) until the binding expires or that provider becomes unusable.
//
// Balancing is skipped entirely when the caller pinned a provider or a routing rule
// forced one — an explicit choice always outranks the pool.
type balancerMode string

const (
	balanceFirst      balancerMode = "first"
	balanceRoundRobin balancerMode = "round_robin"
	// balanceSessionHash derives the provider from the session key itself, so every
	// gateway instance independently reaches the same answer. Required for stickiness
	// to survive a multi-instance deployment; round_robin's cursor is per-process and
	// would send the same conversation to a different node on each instance.
	balanceSessionHash balancerMode = "session_hash"
)

const (
	defaultStickyTTL = 30 * time.Minute
	stickyGCInterval = 5 * time.Minute
)

type stickyBinding struct {
	provider string
	lastSeen time.Time
}

type providerBalancer struct {
	mu      sync.Mutex
	cursors map[string]int            // model → next rotation offset
	sticky  map[string]*stickyBinding // session|model → bound provider
	picks   map[string]int64          // provider → times chosen by the balancer
	lastGC  time.Time
}

func newProviderBalancer() *providerBalancer {
	return &providerBalancer{
		cursors: map[string]int{},
		sticky:  map[string]*stickyBinding{},
		picks:   map[string]int64{},
	}
}

// balancerDecision is why a provider was chosen, surfaced as X-Route-Reason /
// X-Route-Detail so stickiness is debuggable from the client side.
type balancerDecision struct {
	Provider string
	Reason   string // round_robin | sticky_session
	Detail   string
}

func stickyKey(sessionID, model string) string {
	// Keyed by session AND model: the candidate pool is per model, so one session
	// talking to two models must be able to sit on a different provider for each.
	return sessionID + "|" + strings.ToLower(strings.TrimSpace(model))
}

// pick chooses a provider from candidates. Candidates must already be filtered to
// usable providers (enabled, policy-allowed, breaker closed) and be in a stable
// order, since the rotation cursor indexes into it.
func (b *providerBalancer) pick(model, sessionID string, candidates []string, mode balancerMode, sticky bool, ttl time.Duration, now time.Time) (balancerDecision, bool) {
	if b == nil || len(candidates) == 0 {
		return balancerDecision{}, false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gcLocked(ttl, now)

	usable := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		usable[c] = true
	}

	// A local binding exists only where this instance deviated from the deterministic
	// choice — after a failover, or when the hashed provider was not usable. It is an
	// override, not the primary mechanism, so it is consulted first but is allowed to
	// be absent on every other instance.
	if sticky && sessionID != "" {
		key := stickyKey(sessionID, model)
		if bound, ok := b.sticky[key]; ok && now.Sub(bound.lastSeen) <= ttl {
			if usable[bound.provider] {
				bound.lastSeen = now
				b.picks[bound.provider]++
				return balancerDecision{
					Provider: bound.provider,
					Reason:   "sticky_session",
					Detail:   "session " + shortSession(sessionID) + " (로컬 고정)",
				}, true
			}
			// The bound provider left the pool; drop the override and re-derive.
			delete(b.sticky, key)
		}
	}

	// session_hash: rendezvous (highest random weight) hashing. Every instance
	// computes the same provider for the same (session, candidate set) with no shared
	// state, which is what makes stickiness hold across a multi-instance deployment.
	// It also degrades well: removing one provider only remaps ITS sessions, whereas
	// modulo hashing would reshuffle nearly all of them.
	if mode == balanceSessionHash && sessionID != "" {
		chosen := rendezvousPick(stickyKey(sessionID, model), candidates)
		if chosen != "" {
			b.picks[chosen]++
			return balancerDecision{
				Provider: chosen,
				Reason:   "sticky_hash",
				Detail:   "session " + shortSession(sessionID) + " → " + chosen + " (결정적)",
			}, true
		}
	}

	key := strings.ToLower(strings.TrimSpace(model))
	idx := b.cursors[key] % len(candidates)
	b.cursors[key] = (idx + 1) % len(candidates)
	chosen := candidates[idx]
	b.picks[chosen]++

	decision := balancerDecision{
		Provider: chosen,
		Reason:   "round_robin",
		Detail:   itoaProxy(idx+1) + "/" + itoaProxy(len(candidates)),
	}
	if sticky && sessionID != "" {
		b.sticky[stickyKey(sessionID, model)] = &stickyBinding{provider: chosen, lastSeen: now}
		decision.Detail += " · session " + shortSession(sessionID) + " 고정"
	}
	return decision, true
}

// rendezvousPick returns the candidate with the highest hash of (key, candidate).
// Deterministic across processes, uniform over many keys, and stable under pool
// changes: only the sessions owned by a departing provider move.
func rendezvousPick(key string, candidates []string) string {
	best, bestScore := "", ""
	for _, candidate := range candidates {
		score := audit.HashText(key + "\x00" + candidate)
		if best == "" || score > bestScore {
			best, bestScore = candidate, score
		}
	}
	return best
}

// rebind moves a session's binding to the provider that actually served it. After a
// failover the original provider is by definition not serving this session, so the
// binding must follow reality or every subsequent turn would retry the bad node.
func (b *providerBalancer) rebind(model, sessionID, provider string, now time.Time) {
	if b == nil || sessionID == "" || provider == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	key := stickyKey(sessionID, model)
	if bound, ok := b.sticky[key]; ok {
		if bound.provider == provider {
			bound.lastSeen = now
			return
		}
		bound.provider = provider
		bound.lastSeen = now
		return
	}
	b.sticky[key] = &stickyBinding{provider: provider, lastSeen: now}
}

// release drops a session's binding, e.g. when an operator drains a provider.
func (b *providerBalancer) release(provider string) int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	removed := 0
	for key, bound := range b.sticky {
		if provider == "" || bound.provider == provider {
			delete(b.sticky, key)
			removed++
		}
	}
	return removed
}

func (b *providerBalancer) gcLocked(ttl time.Duration, now time.Time) {
	if ttl <= 0 {
		ttl = defaultStickyTTL
	}
	if !b.lastGC.IsZero() && now.Sub(b.lastGC) < stickyGCInterval {
		return
	}
	b.lastGC = now
	for key, bound := range b.sticky {
		if now.Sub(bound.lastSeen) > ttl {
			delete(b.sticky, key)
		}
	}
}

type balancerProviderStat struct {
	Provider string  `json:"provider"`
	Picks    int64   `json:"picks"`
	Share    float64 `json:"share"`
	Sessions int     `json:"sessions"`
}

// stats renders the live distribution so an operator can confirm the pool is
// actually being spread, not just configured to be.
func (b *providerBalancer) stats(ttl time.Duration, now time.Time) (int, []balancerProviderStat) {
	if b == nil {
		return 0, []balancerProviderStat{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if ttl <= 0 {
		ttl = defaultStickyTTL
	}
	sessions := map[string]int{}
	active := 0
	for _, bound := range b.sticky {
		if now.Sub(bound.lastSeen) > ttl {
			continue
		}
		active++
		sessions[bound.provider]++
	}
	var total int64
	for _, n := range b.picks {
		total += n
	}
	out := make([]balancerProviderStat, 0, len(b.picks))
	for name, n := range b.picks {
		share := 0.0
		if total > 0 {
			share = float64(n) / float64(total)
		}
		out = append(out, balancerProviderStat{Provider: name, Picks: n, Share: share, Sessions: sessions[name]})
	}
	for name, n := range sessions {
		if _, seen := b.picks[name]; !seen {
			out = append(out, balancerProviderStat{Provider: name, Sessions: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Picks != out[j].Picks {
			return out[i].Picks > out[j].Picks
		}
		return out[i].Provider < out[j].Provider
	})
	return active, out
}

func shortSession(id string) string {
	if len(id) <= 12 {
		return id
	}
	return id[:12] + "…"
}

func (s *Server) balancerConfig() (mode balancerMode, sticky bool, ttl time.Duration) {
	up := s.cfg.Upstream
	mode = balancerMode(strings.ToLower(strings.TrimSpace(up.LoadBalance)))
	if mode != balanceRoundRobin && mode != balanceSessionHash {
		mode = balanceFirst
	}
	ttl = up.StickyTTL
	if ttl <= 0 {
		ttl = defaultStickyTTL
	}
	return mode, up.StickySessions, ttl
}

// balanceProvider returns the provider the pool selects for this request, or an
// empty decision when balancing does not apply. The returned name is fed to
// selectProviderForced as a forced target, so all the usual resolution (key
// decryption, timeout, enabled check) still happens exactly once.
func (s *Server) balanceProvider(ctx context.Context, r *http.Request, model, sessionID string, authCtx *store.AuthContext) (balancerDecision, bool) {
	mode, sticky, ttl := s.balancerConfig()
	if mode == balanceFirst || strings.TrimSpace(model) == "" {
		return balancerDecision{}, false
	}
	// An explicit client or rule choice outranks the pool.
	if strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) != "" || strings.TrimSpace(r.URL.Query().Get("provider")) != "" {
		return balancerDecision{}, false
	}
	candidates, err := s.providersForModel(ctx, model)
	if err != nil || len(candidates) < 2 {
		// One (or no) matching provider means there is nothing to balance; leave the
		// existing first-match path untouched so behaviour and route_reason stay stable.
		return balancerDecision{}, false
	}

	breakerEnabled, threshold, cooldown := s.breakerConfig()
	now := time.Now()
	usable := make([]string, 0, len(candidates))
	for _, name := range candidates {
		if authCtx != nil && !listAllows(name, authCtx.AllowedProviders, authCtx.DeniedProviders) {
			continue
		}
		// Never hand traffic to a provider the breaker has taken out. peek() is used
		// rather than allow() so this check does not consume the half-open probe.
		if breakerEnabled && !s.breakers.peek(name, threshold, cooldown, now) {
			continue
		}
		usable = append(usable, name)
	}
	if len(usable) == 0 {
		return balancerDecision{}, false
	}
	return s.balancer.pick(model, sessionID, usable, mode, sticky, ttl, now)
}

// Session affinity key resolution.
//
// Stickiness must be per CONVERSATION, not per client. Two qwen code windows open
// on one machine are two sessions and belong on two different providers; the same
// window's turns belong on one. The gateway's inferred session id cannot express
// that — it hashes (api key | ip | user-agent | repo | branch), so every concurrent
// conversation from one developer collapses into a single id and the whole pool
// would degenerate to one provider.
//
// Worse, qwen code sends nothing to identify a session on a generic OpenAI-compatible
// endpoint: its default provider sets only User-Agent plus any user-configured
// customHeaders, and the metadata.sessionId body field is DashScope-only. Its planned
// X-Qwen-Code-Session-Id header is scoped to first-party Alibaba hosts, so a
// third-party gateway will not receive it.
//
// So the fallback derives identity from the request itself: agentic clients resend
// the whole conversation every turn, which makes (system prompt + first user message)
// stable for the life of one conversation and distinct between conversations. Hashing
// that prefix yields a per-conversation key with zero client cooperation — and it is
// the same key that maximises vLLM prefix/KV cache reuse, which is the reason to want
// stickiness in the first place.
const (
	affinitySourceHeader   = "header"
	affinitySourceBody     = "body"
	affinitySourceConv     = "conversation"
	affinitySourceContent  = "content"
	affinitySourceInferred = "inferred"
)

type sessionAffinity struct {
	Key    string
	Source string
}

// conversationAffinity hashes the stable prefix of a chat request. apiKeyID is mixed
// in so two callers who happen to open with the same words do not share a binding.
func conversationAffinity(body []byte, apiKeyID string) string {
	root := jsonMap(body)
	if root == nil {
		return ""
	}
	messages, ok := root["messages"].([]any)
	if !ok || len(messages) == 0 {
		return ""
	}
	var parts []string
	firstUserSeen := false
	for _, item := range messages {
		msg, _ := item.(map[string]any)
		if msg == nil {
			continue
		}
		role := strings.ToLower(stringField(msg["role"]))
		content := flattenContent(msg["content"])
		switch role {
		case "system", "developer":
			// The system prompt is resent verbatim every turn; it anchors the prefix.
			parts = append(parts, "system:"+content)
		case "user":
			if firstUserSeen {
				continue
			}
			firstUserSeen = true
			parts = append(parts, "user:"+content)
		}
		if firstUserSeen && len(parts) > 0 {
			break
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return audit.HashText(apiKeyID + "\x00" + strings.Join(parts, "\x00"))
}

// embeddingAffinity derives an identity from an embedding request's own content.
//
// Embeddings carry no conversation, so conversationAffinity finds nothing and every
// request from one client falls through to the inferred session — a single key. Under
// session_hash that sends an entire batch job to one provider while the rest of the
// pool idles, which defeats load balancing for the most parallel workload there is.
//
// Hashing the input instead spreads distinct inputs across the pool and still sends
// identical ones to the same node, where an upstream embedding cache can serve them.
// There is no conversation to keep warm here, so nothing is lost by not pinning.
func embeddingAffinity(body []byte, apiKeyID string) string {
	root := jsonMap(body)
	if root == nil {
		return ""
	}
	content := flattenContent(root["input"])
	if strings.TrimSpace(content) == "" {
		return ""
	}
	model, _ := root["model"].(string)
	return audit.HashText(apiKeyID + "\x00" + model + "\x00" + content)
}

// resolveSessionAffinity picks the most specific identity available, most
// authoritative first. An explicit id from the client always wins: a caller that
// declares its session knows better than anything the gateway can infer.
func resolveSessionAffinity(r *http.Request, body []byte, apiKeyID, inferredSession string) sessionAffinity {
	if v := firstNonEmptyHeader(r, sessionHeaderNames...); v != "" {
		return sessionAffinity{Key: affinitySourceHeader + ":" + v, Source: affinitySourceHeader}
	}
	if root := jsonMap(body); root != nil {
		if v := explicitBodySession(root); v != "" {
			return sessionAffinity{Key: affinitySourceBody + ":" + v, Source: affinitySourceBody}
		}
	}
	if v := conversationAffinity(body, apiKeyID); v != "" {
		return sessionAffinity{Key: affinitySourceConv + ":" + v, Source: affinitySourceConv}
	}
	if v := embeddingAffinity(body, apiKeyID); v != "" {
		return sessionAffinity{Key: affinitySourceContent + ":" + v, Source: affinitySourceContent}
	}
	if inferredSession != "" {
		// Coarse last resort: groups every concurrent conversation from one client
		// together, so distribution suffers. Only reached for non-chat shapes.
		return sessionAffinity{Key: affinitySourceInferred + ":" + inferredSession, Source: affinitySourceInferred}
	}
	return sessionAffinity{}
}
