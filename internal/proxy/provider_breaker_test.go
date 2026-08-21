package proxy

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestProviderBreakerOpensAfterThresholdAndProbesOnce(t *testing.T) {
	b := newProviderBreakers()
	const threshold = 3
	cooldown := 30 * time.Second
	t0 := time.Unix(1_700_000_000, 0).UTC()

	// Below the threshold the provider stays usable.
	for i := 1; i < threshold; i++ {
		if opened := b.recordFailure("p", "5xx", threshold, t0); opened {
			t.Fatalf("breaker opened early at failure %d", i)
		}
		if !b.allow("p", threshold, cooldown, t0) {
			t.Fatalf("provider blocked before threshold at failure %d", i)
		}
	}

	if opened := b.recordFailure("p", "5xx", threshold, t0); !opened {
		t.Fatal("breaker did not open at threshold")
	}
	if b.allow("p", threshold, cooldown, t0) {
		t.Fatal("open breaker still allowed a dial")
	}
	// Still open one tick before the cooldown elapses.
	if b.allow("p", threshold, cooldown, t0.Add(cooldown-time.Millisecond)) {
		t.Fatal("breaker allowed a dial before the cooldown elapsed")
	}

	// Cooldown elapsed: exactly one probe is admitted, concurrent callers are not.
	probeAt := t0.Add(cooldown)
	if !b.allow("p", threshold, cooldown, probeAt) {
		t.Fatal("breaker did not admit a probe after the cooldown")
	}
	if b.allow("p", threshold, cooldown, probeAt) {
		t.Fatal("breaker admitted a second concurrent probe")
	}

	// A failed probe re-opens immediately rather than waiting for the threshold again.
	if opened := b.recordFailure("p", "timeout", threshold, probeAt); !opened {
		t.Fatal("failed probe did not re-open the breaker")
	}
	if b.allow("p", threshold, cooldown, probeAt) {
		t.Fatal("breaker allowed a dial right after a failed probe")
	}

	// A successful probe closes it.
	recoverAt := probeAt.Add(cooldown)
	if !b.allow("p", threshold, cooldown, recoverAt) {
		t.Fatal("breaker did not admit a second probe")
	}
	b.recordSuccess("p")
	if !b.allow("p", threshold, cooldown, recoverAt) {
		t.Fatal("breaker stayed closed to traffic after a successful probe")
	}
}

// Candidates are filtered before dialling, so a granted probe may never be used when
// an earlier provider answers first. Without an expiry the breaker would stay
// half-open forever and the provider could never recover.
func TestProviderBreakerReleasesAbandonedProbe(t *testing.T) {
	b := newProviderBreakers()
	const threshold = 1
	cooldown := 10 * time.Second
	t0 := time.Unix(1_700_000_000, 0).UTC()

	b.recordFailure("p", "5xx", threshold, t0)
	probeAt := t0.Add(cooldown)
	if !b.allow("p", threshold, cooldown, probeAt) {
		t.Fatal("expected a probe to be admitted")
	}
	// Probe granted but never reported back.
	if b.allow("p", threshold, cooldown, probeAt.Add(cooldown-time.Millisecond)) {
		t.Fatal("a still-fresh probe should block a second one")
	}
	if !b.allow("p", threshold, cooldown, probeAt.Add(cooldown)) {
		t.Fatal("an abandoned probe was never released; provider can never recover")
	}
}

func TestProviderBreakerResetClearsState(t *testing.T) {
	b := newProviderBreakers()
	const threshold = 1
	cooldown := time.Hour
	t0 := time.Unix(1_700_000_000, 0).UTC()

	b.recordFailure("p", "5xx", threshold, t0)
	if b.allow("p", threshold, cooldown, t0) {
		t.Fatal("expected breaker to be open")
	}
	if snaps := b.snapshot(cooldown, t0); len(snaps) != 1 || snaps[0].Phase != string(breakerOpen) {
		t.Fatalf("unexpected snapshot: %+v", snaps)
	}
	b.reset("p")
	if !b.allow("p", threshold, cooldown, t0) {
		t.Fatal("reset did not clear the breaker")
	}
	if snaps := b.snapshot(cooldown, t0); len(snaps) != 0 {
		t.Fatalf("reset left state behind: %+v", snaps)
	}
}

// Healthy providers must not clutter the operator view.
func TestProviderBreakerSnapshotSkipsCleanProviders(t *testing.T) {
	b := newProviderBreakers()
	t0 := time.Unix(1_700_000_000, 0).UTC()
	b.allow("healthy", 3, time.Minute, t0)
	b.recordSuccess("healthy")
	if snaps := b.snapshot(time.Minute, t0); len(snaps) != 0 {
		t.Fatalf("expected no entries for a provider that never failed, got %+v", snaps)
	}
}

// The point of sharing: one instance discovers a dead provider, the others skip it
// instead of each spending their own threshold of failed requests rediscovering it.
func TestSharedBreakerStatePropagatesBetweenInstances(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Upstream.BreakerShared = true
	cfg.Upstream.BreakerThreshold = 2
	cfg.Upstream.BreakerCooldown = time.Hour

	// Two instances over one shared store, exactly like a real deployment.
	instanceA, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	instanceB, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if instanceA.instanceID == instanceB.instanceID {
		t.Fatalf("instances share an id (%q); shared rows could not be attributed", instanceA.instanceID)
	}

	threshold, cooldown := 2, time.Hour
	now := time.Now()

	// A trips the breaker for "dead".
	instanceA.noteBreakerFailure("dead", "5xx", threshold, "trace-1")
	instanceA.noteBreakerFailure("dead", "5xx", threshold, "trace-2")
	if instanceA.breakers.allow("dead", threshold, cooldown, now) {
		t.Fatal("instance A did not open its own breaker")
	}
	// B has seen nothing yet and would still dial it.
	if !instanceB.breakers.allow("dead", threshold, cooldown, now) {
		t.Fatal("instance B blocked a provider it has no evidence against")
	}
	instanceB.breakers.reset("dead") // undo the probe that allow() just consumed

	states, err := db.ListOpenProviderBreakers(context.Background(), now.Add(-2*cooldown))
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].Provider != "dead" {
		t.Fatalf("A did not publish its breaker: %+v", states)
	}
	if states[0].Instance != instanceA.instanceID {
		t.Fatalf("published row attributed to %q, want %q", states[0].Instance, instanceA.instanceID)
	}

	// After a sync, B skips the provider without having failed a single request.
	adopted := instanceB.breakers.adoptRemote(states, now.Add(-cooldown))
	if len(adopted) != 1 || adopted[0] != "dead" {
		t.Fatalf("B did not adopt the peer's state: %v", adopted)
	}
	if instanceB.breakers.allow("dead", threshold, cooldown, now) {
		t.Fatal("B adopted the state but still dials the provider")
	}

	// Recovery propagates the other way: B's probe succeeds and clears the shared row.
	// Probe relative to the time A actually opened the breaker, not the wall clock read
	// before that call — they differ by the few milliseconds the open took.
	afterCooldown := states[0].OpenedAt.Add(cooldown).Add(time.Second)
	if !instanceB.breakers.allow("dead", threshold, cooldown, afterCooldown) {
		t.Fatal("B never got to probe after the cooldown")
	}
	instanceB.noteBreakerSuccess("dead")
	states, err = db.ListOpenProviderBreakers(context.Background(), now.Add(-2*cooldown))
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 0 {
		t.Fatalf("recovery did not clear the shared row: %+v", states)
	}
}

// A peer's verdict is second-hand. It must never override what this instance has
// observed itself, and must age out so an instance that died while a breaker was open
// cannot exclude a provider forever.
func TestAdoptRemoteRespectsLocalEvidenceAndExpiry(t *testing.T) {
	b := newProviderBreakers()
	now := time.Unix(1_700_000_000, 0).UTC()
	cooldownCutoff := now.Add(-30 * time.Second)

	// Stale report: older than a cooldown, so it is ignored outright.
	stale := []store.ProviderBreakerState{{Provider: "old", Phase: "open", OpenedAt: now.Add(-time.Hour)}}
	if adopted := b.adoptRemote(stale, cooldownCutoff); len(adopted) != 0 {
		t.Fatalf("adopted a stale peer report: %v", adopted)
	}
	if !b.allow("old", 3, 30*time.Second, now) {
		t.Fatal("a stale peer report still blocked the provider")
	}

	// Local state wins: a provider already probing locally must not be reset by a peer.
	b.recordFailure("probing", "5xx", 1, now.Add(-time.Minute))
	b.allow("probing", 1, time.Second, now) // moves to half-open, consuming the probe
	fresh := []store.ProviderBreakerState{{Provider: "probing", Phase: "open", OpenedAt: now}}
	if adopted := b.adoptRemote(fresh, cooldownCutoff); len(adopted) != 0 {
		t.Fatalf("peer state overwrote first-hand local state: %v", adopted)
	}

	// A fresh report about a provider this instance considers healthy is adopted.
	if adopted := b.adoptRemote([]store.ProviderBreakerState{{Provider: "new", Phase: "open", OpenedAt: now, Instance: "peer-1"}}, cooldownCutoff); len(adopted) != 1 {
		t.Fatalf("did not adopt a fresh peer report: %v", adopted)
	}
	snaps := b.snapshot(30*time.Second, now)
	found := false
	for _, sn := range snaps {
		if sn.Provider == "new" && strings.Contains(sn.LastReason, "peer-1") {
			found = true
		}
	}
	if !found {
		t.Fatalf("adopted state does not record which peer reported it: %+v", snaps)
	}
}

// Sharing is opt-in because it needs a shared database; with per-instance SQLite there
// is nothing to share and publishing would be pure overhead.
func TestBreakerSharingIsOptIn(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://unused.invalid", "s")
	cfg.Upstream.BreakerThreshold = 1
	server, err := NewServer(cfg, db, logger, nil) // BreakerShared defaults to false
	if err != nil {
		t.Fatal(err)
	}
	if server.breakerSharingEnabled() {
		t.Fatal("breaker sharing should be off by default")
	}
	server.noteBreakerFailure("dead", "5xx", 1, "trace")
	states, err := db.ListOpenProviderBreakers(context.Background(), time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 0 {
		t.Fatalf("state was published with sharing disabled: %+v", states)
	}
}
