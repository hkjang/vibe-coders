package proxy

import (
	"sync"
	"time"
)

// dwQueryCache is a short-TTL in-memory cache for DW dashboard ClickHouse reads. The DW
// dashboard is polled by many admins against the same windows; caching identical queries
// for a few tens of seconds shields ClickHouse from repeated full-rollup scans (the spec's
// "30-60s cache" requirement). Keyed by ClickHouse URL + the full query SQL so a runtime
// connection swap never serves another cluster's rows. Cached rows are treated as
// read-only by callers (handlers only read values and build fresh output maps).
type dwQueryCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	entries map[string]dwCacheEntry
}

type dwCacheEntry struct {
	rows   []map[string]any
	stored time.Time
}

// newDWQueryCache builds a cache with the given TTL (default 45s, mid-range of the spec's
// 30-60s window, when ttl <= 0).
func newDWQueryCache(ttl time.Duration) *dwQueryCache {
	if ttl <= 0 {
		ttl = 45 * time.Second
	}
	return &dwQueryCache{ttl: ttl, entries: map[string]dwCacheEntry{}}
}

// get returns cached rows for a key if still within the TTL.
func (c *dwQueryCache) get(key string, now time.Time) ([]map[string]any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.stored) > c.ttl {
		return nil, false
	}
	return e.rows, true
}

// put stores rows under a key, opportunistically evicting expired entries to bound memory.
func (c *dwQueryCache) put(key string, rows []map[string]any, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) > 256 {
		for k, e := range c.entries {
			if now.Sub(e.stored) > c.ttl {
				delete(c.entries, k)
			}
		}
	}
	c.entries[key] = dwCacheEntry{rows: rows, stored: now}
}

// clear drops all cached entries (used by the refresh endpoint) and returns the count cleared.
func (c *dwQueryCache) clear() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(c.entries)
	c.entries = map[string]dwCacheEntry{}
	return n
}
