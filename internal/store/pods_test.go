package store

import (
	"context"
	"testing"
	"time"
)

func TestPodStatusUpsertAndStale(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	now := time.Now().UTC()
	// Fresh, converged pod.
	if err := db.UpsertPodStatus(ctx, PodStatus{Hostname: "pod-a", BuildVersion: "v1", AppliedToken: "t1", CurrentToken: "t1", ReloadIntervalS: 10, LastSeen: now.Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	// Stale, not-yet-converged pod (old heartbeat, applied != current).
	if err := db.UpsertPodStatus(ctx, PodStatus{Hostname: "pod-b", BuildVersion: "v1", AppliedToken: "t0", CurrentToken: "t1", ReloadIntervalS: 10, LastSeen: now.Add(-10 * time.Minute).Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}

	pods, err := db.ListPods(ctx, 90*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]PodStatus{}
	for _, p := range pods {
		got[p.Hostname] = p
	}
	if len(got) != 2 {
		t.Fatalf("want 2 pods, got %d", len(got))
	}
	if got["pod-a"].Stale || !got["pod-a"].UpToDate {
		t.Fatalf("pod-a should be live+converged: %+v", got["pod-a"])
	}
	if !got["pod-b"].Stale || got["pod-b"].UpToDate {
		t.Fatalf("pod-b should be stale+not-converged: %+v", got["pod-b"])
	}

	// Upsert is idempotent on hostname (refresh, not duplicate).
	if err := db.UpsertPodStatus(ctx, PodStatus{Hostname: "pod-a", BuildVersion: "v2", AppliedToken: "t1", CurrentToken: "t1", LastSeen: now.Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	pods2, _ := db.ListPods(ctx, 90*time.Second)
	if len(pods2) != 2 {
		t.Fatalf("upsert must not duplicate, got %d pods", len(pods2))
	}
	for _, p := range pods2 {
		if p.Hostname == "pod-a" && p.BuildVersion != "v2" {
			t.Fatalf("pod-a build should refresh to v2, got %q", p.BuildVersion)
		}
	}
}
