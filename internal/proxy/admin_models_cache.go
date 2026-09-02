package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

const (
	adminModelsCatalogFreshTTL       = 20 * time.Second
	adminModelsCatalogStaleTTL       = 10 * time.Minute
	adminModelsCatalogMaxConcurrency = 4
)

// adminModelCatalogRow is the deliberately small subset of an upstream model object that
// the gateway retains. Provider catalogues are arbitrary JSON, so caching their raw maps would
// keep fields the UI never needs (and potentially provider-specific metadata) in memory.
type adminModelCatalogRow struct {
	ID      string
	Object  string
	OwnedBy string
	Created *int64
}

type adminModelCatalogCacheEntry struct {
	fingerprint string
	models      []adminModelCatalogRow
	fetchedAt   time.Time
}

type adminModelCatalogFlight struct {
	done               chan struct{}
	result             adminProviderModelsResult
	leaderContextEnded bool
}

// adminModelCatalogCache keeps a short, process-local last-known-good catalogue per Provider.
// It also coalesces concurrent refreshes and applies one process-wide outbound limit, so several
// administrators polling the same page cannot multiply Provider traffic without bound.
type adminModelCatalogCache struct {
	mu        sync.Mutex
	entries   map[string]adminModelCatalogCacheEntry
	flights   map[string]*adminModelCatalogFlight
	semaphore chan struct{}
	freshTTL  time.Duration
	staleTTL  time.Duration
	now       func() time.Time
}

func newAdminModelCatalogCache() *adminModelCatalogCache {
	return &adminModelCatalogCache{
		entries:   make(map[string]adminModelCatalogCacheEntry),
		flights:   make(map[string]*adminModelCatalogFlight),
		semaphore: make(chan struct{}, adminModelsCatalogMaxConcurrency),
		freshTTL:  adminModelsCatalogFreshTTL,
		staleTTL:  adminModelsCatalogStaleTTL,
		now:       time.Now,
	}
}

func adminModelProviderFingerprint(provider store.ProviderConfig, fallbackTimeout time.Duration) string {
	hash := sha256.New()
	for _, value := range []string{
		provider.Name,
		provider.BaseURL,
		provider.EncryptedAPIKey,
		strconv.Itoa(provider.TimeoutMS),
		fallbackTimeout.String(),
	} {
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func cloneAdminModelCatalogRows(source []adminModelCatalogRow) []adminModelCatalogRow {
	if len(source) == 0 {
		return []adminModelCatalogRow{}
	}
	cloned := make([]adminModelCatalogRow, len(source))
	copy(cloned, source)
	for index := range cloned {
		if source[index].Created != nil {
			created := *source[index].Created
			cloned[index].Created = &created
		}
	}
	return cloned
}

func cloneAdminProviderModelsResult(source adminProviderModelsResult) adminProviderModelsResult {
	source.models = cloneAdminModelCatalogRows(source.models)
	return source
}

func (cache *adminModelCatalogCache) prune(configs []store.ProviderConfig, fallbackTimeout time.Duration) {
	valid := make(map[string]string, len(configs))
	for _, provider := range configs {
		if provider.Enabled {
			valid[provider.Name] = adminModelProviderFingerprint(provider, fallbackTimeout)
		}
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for name, entry := range cache.entries {
		if fingerprint, ok := valid[name]; !ok || fingerprint != entry.fingerprint {
			delete(cache.entries, name)
		}
	}
}

func (cache *adminModelCatalogCache) cached(
	provider store.ProviderConfig,
	fallbackTimeout time.Duration,
	allowStale bool,
) (adminProviderModelsResult, bool) {
	fingerprint := adminModelProviderFingerprint(provider, fallbackTimeout)
	now := cache.now()
	cache.mu.Lock()
	entry, ok := cache.entries[provider.Name]
	cache.mu.Unlock()
	if !ok || entry.fingerprint != fingerprint {
		return adminProviderModelsResult{}, false
	}
	age := now.Sub(entry.fetchedAt)
	if age < 0 {
		age = 0
	}
	if age > cache.freshTTL && (!allowStale || age > cache.staleTTL) {
		return adminProviderModelsResult{}, false
	}
	return adminProviderModelsResult{
		config:    provider,
		models:    cloneAdminModelCatalogRows(entry.models),
		status:    "ok",
		source:    adminModelSourceCache,
		fetchedAt: entry.fetchedAt.UTC().Format(time.RFC3339Nano),
		stale:     age > cache.freshTTL,
	}, true
}

func (cache *adminModelCatalogCache) staleAfterFailure(
	provider store.ProviderConfig,
	fallbackTimeout time.Duration,
	code string,
) adminProviderModelsResult {
	if result, ok := cache.cached(provider, fallbackTimeout, true); ok {
		result.stale = true
		result.failureCode = code
		return result
	}
	return adminProviderModelsResult{
		config: provider, status: "failed", source: adminModelSourceLive, failureCode: code,
	}
}

func (cache *adminModelCatalogCache) load(
	ctx context.Context,
	provider store.ProviderConfig,
	fallbackTimeout time.Duration,
	fetch func(context.Context) ([]adminModelCatalogRow, error),
) adminProviderModelsResult {
	if result, ok := cache.cached(provider, fallbackTimeout, false); ok {
		return result
	}

	fingerprint := adminModelProviderFingerprint(provider, fallbackTimeout)
	flightKey := provider.Name + "\x00" + fingerprint
	for attempt := 0; attempt < 2; attempt++ {
		cache.mu.Lock()
		if flight, ok := cache.flights[flightKey]; ok {
			cache.mu.Unlock()
			select {
			case <-ctx.Done():
				return adminProviderModelsResult{
					config: provider, status: "failed", source: adminModelSourceLive,
					failureCode: "provider_models_unavailable",
				}
			case <-flight.done:
				result := cloneAdminProviderModelsResult(flight.result)
				// If the request leading the shared refresh disappeared, one still-live waiter
				// gets one chance to become the next leader instead of inheriting cancellation.
				if flight.leaderContextEnded && result.status == "failed" && attempt == 0 && ctx.Err() == nil {
					continue
				}
				return result
			}
		}
		flight := &adminModelCatalogFlight{done: make(chan struct{})}
		cache.flights[flightKey] = flight
		cache.mu.Unlock()

		result := cache.runLeader(ctx, provider, fallbackTimeout, fingerprint, fetch)
		cache.mu.Lock()
		flight.result = cloneAdminProviderModelsResult(result)
		flight.leaderContextEnded = ctx.Err() != nil
		close(flight.done)
		delete(cache.flights, flightKey)
		cache.mu.Unlock()
		return result
	}

	return adminProviderModelsResult{
		config: provider, status: "failed", source: adminModelSourceLive,
		failureCode: "provider_models_unavailable",
	}
}

func (cache *adminModelCatalogCache) runLeader(
	ctx context.Context,
	provider store.ProviderConfig,
	fallbackTimeout time.Duration,
	fingerprint string,
	fetch func(context.Context) ([]adminModelCatalogRow, error),
) adminProviderModelsResult {
	select {
	case cache.semaphore <- struct{}{}:
		defer func() { <-cache.semaphore }()
	case <-ctx.Done():
		return cache.staleAfterFailure(provider, fallbackTimeout, "provider_models_unavailable")
	}

	models, err := fetch(ctx)
	if err != nil {
		return cache.staleAfterFailure(provider, fallbackTimeout, "provider_models_unavailable")
	}
	fetchedAt := cache.now().UTC()
	models = cloneAdminModelCatalogRows(models)
	cache.mu.Lock()
	cache.entries[provider.Name] = adminModelCatalogCacheEntry{
		fingerprint: fingerprint,
		models:      cloneAdminModelCatalogRows(models),
		fetchedAt:   fetchedAt,
	}
	cache.mu.Unlock()
	return adminProviderModelsResult{
		config: provider, models: models, status: "ok", source: adminModelSourceLive,
		fetchedAt: fetchedAt.Format(time.RFC3339Nano), stale: false,
	}
}
