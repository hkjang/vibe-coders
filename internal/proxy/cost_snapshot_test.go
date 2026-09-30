package proxy

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestCostSnapshotRuntimeParsingAndTTLRemainCompatible(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	for _, input := range []struct {
		enabled, threshold string
		wantEnabled        bool
		wantThreshold      float64
	}{
		{"true", " 47.25 ", true, 47.25},
		{"1", "0", true, 0},
		{"TRUE", "-1", false, -1},
		{"malformed", "malformed", false, 0},
		{"false", "NaN", false, math.NaN()},
		{"0", "+Inf", false, math.Inf(1)},
	} {
		if _, err := db.SaveRuntimeFlagBatch(t.Context(), []store.RuntimeFlag{
			{Key: "cost_guard_enabled", Value: input.enabled},
			{Key: "cost_guard_threshold_krw", Value: input.threshold},
		}, costGuardFlagKeys); err != nil {
			t.Fatal(err)
		}
		s.invalidateCostCache()
		snapshot := s.costSnapshotCached(t.Context())
		if snapshot.guardEnabled != input.wantEnabled || !(snapshot.guardThreshold == input.wantThreshold || math.IsNaN(snapshot.guardThreshold) && math.IsNaN(input.wantThreshold)) {
			t.Fatalf("runtime parsing changed for %+v", input)
		}
		if again := s.costSnapshotCached(t.Context()); again != snapshot {
			t.Fatal("valid cached snapshot was not reused")
		}
	}
	cached := s.costCache.Load()
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "cost_guard_threshold_krw", Value: "7"}); err != nil {
		t.Fatal(err)
	}
	if s.costSnapshotCached(t.Context()) != cached {
		t.Fatal("external changes must retain the existing TTL behavior")
	}
	expired := *cached
	expired.fetchedAt = time.Now().Add(-costSnapshotTTL - time.Second)
	s.costCache.Store(&expired)
	if fresh := s.costSnapshotCached(t.Context()); fresh == &expired || fresh.guardThreshold != 7 {
		t.Fatal("expired snapshot was not refreshed")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	s.invalidateCostCache()
	if failed := s.costSnapshotCached(ctx); failed.guardEnabled || failed.guardThreshold != 0 || len(failed.byModel) != 0 {
		t.Fatal("runtime read failures no longer preserve their established defaults")
	}
}

// Pause the first database operation without a production hook. Done must be
// released before another database operation; a driver may hold its pool lock.
type costSnapshotReadBarrier struct {
	context.Context
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *costSnapshotReadBarrier) Done() <-chan struct{} {
	c.once.Do(func() {
		close(c.started)
		<-c.release
	})
	return c.Context.Done()
}

func TestCostSnapshotInvalidationWaitsForMissPublication(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	ctx := &costSnapshotReadBarrier{Context: t.Context(), started: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(ctx.release) })
	loaded := make(chan *costSnapshot, 1)
	go func() { loaded <- s.costSnapshotCached(ctx) }()
	select {
	case <-ctx.started:
	case <-time.After(5 * time.Second):
		t.Fatal("cache miss did not reach the database")
	}
	invalidating, invalidated := make(chan struct{}), make(chan struct{})
	go func() {
		close(invalidating)
		s.invalidateCostCache()
		close(invalidated)
	}()
	<-invalidating
	select {
	case <-invalidated:
		t.Error("invalidation overtook an in-flight cache miss")
	case <-time.After(50 * time.Millisecond):
	}
	release.Do(func() { close(ctx.release) })
	select {
	case <-loaded:
	case <-time.After(5 * time.Second):
		t.Fatal("cache miss did not finish")
	}
	select {
	case <-invalidated:
	case <-time.After(5 * time.Second):
		t.Fatal("invalidation did not finish")
	}
	if s.costCache.Load() != nil {
		t.Fatal("in-flight miss republished stale state after invalidation")
	}
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "cost_guard_threshold_krw", Value: "42"}); err != nil {
		t.Fatal(err)
	}
	if s.costSnapshotCached(t.Context()).guardThreshold != 42 {
		t.Fatal("next cache miss did not load the saved value")
	}
}
