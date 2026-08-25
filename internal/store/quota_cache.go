package store

import "time"

// Caching the quota definitions.
//
// checkQuotas asks for the quotas of every scope a request falls under — global, the API
// key, the client IP, and the team when there is one — and each ask was its own query
// against the same small table. Three per request with no team, four with one.
//
// What is cached is the *definitions*: the limits an operator set. Usage is not, and must
// not be — UsageSince and ReservedUsage read live counters and are what enforcement
// actually compares against. A stale limit for a moment is an operator's edit arriving a
// beat late; a stale usage figure would be a quota that stops working.
//
// See ttl_cache.go for how invalidation and the TTL divide the work. The whole enabled set
// is held rather than one entry per scope: the table is operator-sized, so filtering it in
// memory costs less than the map bookkeeping would, and a single slot means a single
// invalidation with nothing to miss.
type quotaCache struct {
	active cachedValue[[]QuotaRecord]
}

func (c *quotaCache) invalidate() { c.active.clear() }

func (c *quotaCache) beginLoad() uint64 { return c.active.begin() }

func (c *quotaCache) storeActive(quotas []QuotaRecord, gen uint64, now time.Time) {
	c.active.putIfCurrent(append([]QuotaRecord(nil), quotas...), gen, now)
}

// filter returns the cached quotas for one scope. The result is a fresh slice built here,
// so the cached one never leaves this method.
func (c *quotaCache) filter(scope, scopeValue string, now time.Time) ([]QuotaRecord, bool) {
	all, ok := c.active.get(now)
	if !ok {
		return nil, false
	}
	result := []QuotaRecord{}
	for _, q := range all {
		if q.Scope == scope && q.ScopeValue == scopeValue {
			result = append(result, q)
		}
	}
	return result, true
}

// filterQuotas is the same selection applied to a freshly loaded set, kept next to filter
// so the two cannot drift apart.
func filterQuotas(all []QuotaRecord, scope, scopeValue string) []QuotaRecord {
	result := []QuotaRecord{}
	for _, q := range all {
		if q.Scope == scope && q.ScopeValue == scopeValue {
			result = append(result, q)
		}
	}
	return result
}
