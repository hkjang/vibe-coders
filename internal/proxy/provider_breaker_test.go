package proxy

import (
	"testing"
	"time"
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
