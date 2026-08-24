package store

import (
	"sync"
	"time"
)

// Caching the provider table.
//
// provider_configs is read several times while serving one request: routing asks which
// providers match the model, the balancer asks again to build the failover list, and
// dialUpstream asks a third time to resolve the one it settled on. Each ask was its own
// query. On SQLite that is a function call and the repetition is invisible; on Postgres
// it is a network round trip. Logging every statement for a 2 KB chat request against
// Postgres showed five provider reads out of nineteen synchronous queries — the largest
// single group, and all of them returning identical rows.
//
// The rows change only when an operator edits a provider, so they are held in memory.
// Writes through this store drop the cache immediately, which makes the single-instance
// case exact: an admin edit is visible to the very next request. The TTL exists only for
// the case this store cannot observe — a *different* gateway process editing the same
// database. Without it, that edit would never be picked up; with it, the window is
// bounded by providerCacheTTL.
//
// Reads hand back a copy. The cached slice outlives the call, so returning it directly
// would let one caller's edit change what every later caller sees.
const providerCacheTTL = 3 * time.Second

type providerCache struct {
	mu sync.Mutex

	configs   []ProviderConfig
	configsAt time.Time

	public   []ProviderPublic
	publicAt time.Time

	// byName holds every row, disabled ones included, because GetProvider is asked about
	// providers the routing list deliberately leaves out.
	byName   map[string]ProviderConfig
	byNameAt time.Time
}

// invalidate drops the cached rows so the next read goes to the database. Every write
// path that touches provider_configs must call it — including the ones that bypass
// UpsertProvider, such as secret rotation rewriting encrypted_api_key in place.
func (c *providerCache) invalidate() {
	c.mu.Lock()
	c.configs, c.public, c.byName = nil, nil, nil
	c.configsAt, c.publicAt, c.byNameAt = time.Time{}, time.Time{}, time.Time{}
	c.mu.Unlock()
}

func (c *providerCache) freshConfigs(now time.Time) ([]ProviderConfig, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.configsAt.IsZero() || now.Sub(c.configsAt) >= providerCacheTTL {
		return nil, false
	}
	return append([]ProviderConfig(nil), c.configs...), true
}

func (c *providerCache) storeConfigs(rows []ProviderConfig, now time.Time) {
	c.mu.Lock()
	c.configs = append([]ProviderConfig(nil), rows...)
	c.configsAt = now
	c.mu.Unlock()
}

func (c *providerCache) freshPublic(now time.Time) ([]ProviderPublic, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.publicAt.IsZero() || now.Sub(c.publicAt) >= providerCacheTTL {
		return nil, false
	}
	return append([]ProviderPublic(nil), c.public...), true
}

func (c *providerCache) storePublic(rows []ProviderPublic, now time.Time) {
	c.mu.Lock()
	c.public = append([]ProviderPublic(nil), rows...)
	c.publicAt = now
	c.mu.Unlock()
}

// lookup answers a single-provider query from the cached table. ProviderConfig is all
// scalars, so the returned value shares nothing with the map and the map never escapes
// the lock.
func (c *providerCache) lookup(name string, now time.Time) (ProviderConfig, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byNameAt.IsZero() || now.Sub(c.byNameAt) >= providerCacheTTL {
		return ProviderConfig{}, false, false
	}
	p, found := c.byName[name]
	return p, found, true
}

func (c *providerCache) storeByName(rows map[string]ProviderConfig, now time.Time) {
	c.mu.Lock()
	c.byName = rows
	c.byNameAt = now
	c.mu.Unlock()
}
