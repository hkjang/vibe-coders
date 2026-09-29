package proxy

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"io"
	"sync"
	"time"
)

const (
	appUITelemetryCallerDailyLimit = 600
	appUITelemetryCallerLimit      = 4096
)

// This additional, deliberately lossy quota prevents one authenticated caller
// from rapidly consuming the shared visit capacity. Only daily HMAC digests and
// counters live in bounded process memory; raw identities and the random key are
// never persisted or logged. Events across features, sessions, and event kinds
// share a budget. Legacy/open authentication intentionally shares one identity.
// Restarts and separate pods have separate budgets, not a durable cluster quota.
type appUITelemetryCallerQuota struct {
	mu      sync.Mutex
	day     time.Time
	salt    [sha256.Size]byte
	counts  map[[sha256.Size]byte]uint16
	entropy io.Reader // nil uses crypto/rand.Reader; injected only by tests
}

var processAppUITelemetryCallerQuota appUITelemetryCallerQuota

func (q *appUITelemetryCallerQuota) acquire(principalID string, now time.Time) bool {
	if principalID == "" {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	day := now.UTC().Truncate(24 * time.Hour)
	// Never rotate backwards: clock corrections must not reset spent budgets.
	if q.day.IsZero() || day.After(q.day) {
		var salt [sha256.Size]byte
		entropy := q.entropy
		if entropy == nil {
			entropy = rand.Reader
		}
		if _, err := io.ReadFull(entropy, salt[:]); err != nil {
			// Keep existing state untouched. No predictable fallback key, partial
			// rotation, or raw-ID map is permitted if secure entropy is unavailable.
			return false
		}
		q.salt = salt
		q.day = day
		q.counts = make(map[[sha256.Size]byte]uint16)
	}
	mac := hmac.New(sha256.New, q.salt[:])
	_, _ = io.WriteString(mac, principalID)
	var digest [sha256.Size]byte
	mac.Sum(digest[:0])
	count, exists := q.counts[digest]
	if count >= appUITelemetryCallerDailyLimit || (!exists && len(q.counts) >= appUITelemetryCallerLimit) {
		// Do not evict an active entry: eviction would replenish its quota.
		return false
	}
	q.counts[digest] = count + 1
	return true
}
