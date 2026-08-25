package store

import (
	"sync"
	"time"
)

// Caching a configuration table in memory.
//
// Several tables are read on the hot path many times per request and written only when an
// operator changes something: providers, governance policies. On SQLite re-reading them is
// a function call; on Postgres each read is a network round trip, and the repetition
// dominates.
//
// The shape is the same every time, so it lives here once:
//
//   - A write through this store clears the value immediately. That makes the
//     single-process case exact — an admin edit is visible to the very next request, which
//     is the half a plain TTL cache gets wrong.
//   - The TTL covers only what this process cannot observe: another gateway writing to the
//     same database. Without it that edit would never be seen; with it the window is
//     bounded.
//
// Callers are responsible for not handing out anything the cache still owns. See the
// comment on each cache for what it copies.
const configCacheTTL = 3 * time.Second

// cachedValue holds one value with an expiry. The zero value is an empty cache.
//
// The generation counter closes a race that the expiry alone does not. A reader can query
// the database, a writer can commit and invalidate, and only then can the reader store
// what it read — which is the pre-commit state, now cached as if it were current. The
// window is small but the consequence is not: for governance rules it means enforcing a
// policy the operator has already withdrawn. A reader takes the generation before it
// queries and its result is accepted only if nothing invalidated in between.
type cachedValue[T any] struct {
	mu     sync.Mutex
	value  T
	loaded time.Time
	gen    uint64
}

// begin returns the generation a loader should pass back to putIfCurrent.
func (c *cachedValue[T]) begin() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

// putIfCurrent stores the value unless the cache was invalidated since begin. A rejected
// store is not an error: the value is still returned to the caller that loaded it, it just
// does not become what everybody else sees.
func (c *cachedValue[T]) putIfCurrent(value T, gen uint64, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen {
		return false
	}
	c.value = value
	c.loaded = now
	return true
}

// get returns the cached value if it is still fresh.
func (c *cachedValue[T]) get(now time.Time) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded.IsZero() || now.Sub(c.loaded) >= configCacheTTL {
		var zero T
		return zero, false
	}
	return c.value, true
}

// clear drops the value so the next read reloads it, and retires any load already in
// flight.
func (c *cachedValue[T]) clear() {
	c.mu.Lock()
	var zero T
	c.value = zero
	c.loaded = time.Time{}
	c.gen++
	c.mu.Unlock()
}
