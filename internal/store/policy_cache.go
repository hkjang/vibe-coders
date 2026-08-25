package store

import "time"

// Caching the active governance rules.
//
// enforceOpenAIGovernance runs three times per request — once on the request body, once
// after the cost estimate, once after a provider is chosen — and each run loaded the
// active rule set from scratch. That is three identical queries per request, each of them
// joining policy_rules to policies and then JSON-decoding every rule's conditions and
// actions. On Postgres the round trip dominates; the decoding is paid on both drivers.
//
// See ttl_cache.go for how invalidation and the TTL divide the work. Rules change through
// exactly one path, UpsertPolicyWithRules, which is where the invalidation lives.
//
// What is shared and what is copied: the slice is copied on every read, so a caller
// cannot reorder or overwrite entries for everyone else. The Conditions and Actions maps
// inside each rule are not — copying them per request would give back most of what the
// decode was costing. Nothing writes to them today, and
// TestGovernanceRulesAreTreatedAsReadOnly fails the build if that changes.
type policyCache struct {
	activeRules cachedValue[[]PolicyRule]
}

func (c *policyCache) invalidate() { c.activeRules.clear() }

func (c *policyCache) freshActiveRules(now time.Time) ([]PolicyRule, bool) {
	rules, ok := c.activeRules.get(now)
	if !ok {
		return nil, false
	}
	return append([]PolicyRule(nil), rules...), true
}

func (c *policyCache) beginLoad() uint64 { return c.activeRules.begin() }

func (c *policyCache) storeActiveRules(rules []PolicyRule, gen uint64, now time.Time) {
	c.activeRules.putIfCurrent(append([]PolicyRule(nil), rules...), gen, now)
}
