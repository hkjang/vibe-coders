package store

import "time"

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
// See ttl_cache.go for how invalidation and the TTL divide the work.
//
// Reads hand back a copy of the slice. The cached slice outlives the call, so returning it
// directly would let one caller's edit change what every later caller sees. ProviderConfig
// is all scalars, so copying the slice is enough — there is nothing underneath to share.
type providerCache struct {
	configs cachedValue[[]ProviderConfig]
	public  cachedValue[[]ProviderPublic]
	// byName holds every row, disabled ones included, because GetProvider is asked about
	// providers the routing list deliberately leaves out.
	byName cachedValue[map[string]ProviderConfig]
}

// invalidate drops the cached rows so the next read reloads them. Every write path that
// touches provider_configs must call it — including the ones that bypass UpsertProvider,
// such as secret rotation rewriting encrypted_api_key in place.
func (c *providerCache) invalidate() {
	c.configs.clear()
	c.public.clear()
	c.byName.clear()
}

func (c *providerCache) freshConfigs(now time.Time) ([]ProviderConfig, bool) {
	rows, ok := c.configs.get(now)
	if !ok {
		return nil, false
	}
	return append([]ProviderConfig(nil), rows...), true
}

func (c *providerCache) beginConfigs() uint64 { return c.configs.begin() }

func (c *providerCache) storeConfigs(rows []ProviderConfig, gen uint64, now time.Time) {
	c.configs.putIfCurrent(append([]ProviderConfig(nil), rows...), gen, now)
}

func (c *providerCache) freshPublic(now time.Time) ([]ProviderPublic, bool) {
	rows, ok := c.public.get(now)
	if !ok {
		return nil, false
	}
	return append([]ProviderPublic(nil), rows...), true
}

func (c *providerCache) beginPublic() uint64 { return c.public.begin() }

func (c *providerCache) storePublic(rows []ProviderPublic, gen uint64, now time.Time) {
	c.public.putIfCurrent(append([]ProviderPublic(nil), rows...), gen, now)
}

// lookup answers a single-provider query from the cached table. ProviderConfig is all
// scalars, so the returned value shares nothing with the map.
func (c *providerCache) lookup(name string, now time.Time) (ProviderConfig, bool, bool) {
	byName, ok := c.byName.get(now)
	if !ok {
		return ProviderConfig{}, false, false
	}
	p, found := byName[name]
	return p, found, true
}

func (c *providerCache) beginByName() uint64 { return c.byName.begin() }

func (c *providerCache) storeByName(rows map[string]ProviderConfig, gen uint64, now time.Time) {
	c.byName.putIfCurrent(rows, gen, now)
}
