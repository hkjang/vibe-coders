package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"sync"
	"time"
)

// sessionInferer groups requests that arrive WITHOUT an explicit session id into
// "inferred" sessions, using a sliding inactivity window keyed by client identity.
//
// Most AI coding tools (Claude Code, Cursor, Roo Code, Qwen Code) never expose a
// session id at the HTTP level — they keep conversation state client-side. Without
// inference every request would be its own session. APMs solve this by running
// "inferred" sessions alongside "explicit" ones: requests from the same client that
// arrive close together are treated as one session until the client goes quiet for
// longer than the idle window, which starts a fresh session.
type sessionInferer struct {
	mu      sync.Mutex
	entries map[string]*inferredSession
	idle    time.Duration
	lastGC  time.Time
}

type inferredSession struct {
	id       string
	lastSeen time.Time
}

func newSessionInferer(idle time.Duration) *sessionInferer {
	if idle <= 0 {
		idle = 30 * time.Minute
	}
	return &sessionInferer{entries: map[string]*inferredSession{}, idle: idle}
}

// sessionFor returns the inferred session id for a client identity at time now.
// If the identity was last seen within the idle window, the same id is reused and
// the window slides forward; otherwise a fresh id is minted.
func (si *sessionInferer) sessionFor(identity string, now time.Time) string {
	si.mu.Lock()
	defer si.mu.Unlock()
	si.gc(now)
	if e, ok := si.entries[identity]; ok && now.Sub(e.lastSeen) <= si.idle {
		e.lastSeen = now
		return e.id
	}
	id := mintSessionID(identity, now)
	si.entries[identity] = &inferredSession{id: id, lastSeen: now}
	return id
}

func (si *sessionInferer) existingSession(identity string, now time.Time) (string, bool) {
	si.mu.Lock()
	defer si.mu.Unlock()
	si.gc(now)
	if e, ok := si.entries[identity]; ok && now.Sub(e.lastSeen) <= si.idle {
		e.lastSeen = now
		return e.id, true
	}
	return "", false
}

func (si *sessionInferer) sessionForRecovered(identity string, now time.Time, recoveredID string, recoveredLastSeen time.Time) string {
	si.mu.Lock()
	defer si.mu.Unlock()
	si.gc(now)
	if e, ok := si.entries[identity]; ok && now.Sub(e.lastSeen) <= si.idle {
		e.lastSeen = now
		return e.id
	}
	if recoveredID != "" && !recoveredLastSeen.IsZero() && now.Sub(recoveredLastSeen) <= si.idle {
		si.entries[identity] = &inferredSession{id: recoveredID, lastSeen: now}
		return recoveredID
	}
	id := mintSessionID(identity, now)
	si.entries[identity] = &inferredSession{id: id, lastSeen: now}
	return id
}

// mintSessionID derives a short, opaque, stable id from the identity and the
// session's start time, so re-minting after an idle gap yields a distinct id.
func mintSessionID(identity string, now time.Time) string {
	sum := sha256.Sum256([]byte(identity + "|" + strconv.FormatInt(now.UnixNano(), 10)))
	return "sess_" + hex.EncodeToString(sum[:])[:12]
}

// gc evicts entries that have been idle past the window. Cheap and lazy: runs at
// most once per idle interval.
func (si *sessionInferer) gc(now time.Time) {
	if !si.lastGC.IsZero() && now.Sub(si.lastGC) < si.idle {
		return
	}
	si.lastGC = now
	for k, e := range si.entries {
		if now.Sub(e.lastSeen) > si.idle {
			delete(si.entries, k)
		}
	}
}
