package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestCanaryPolicyStats(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "canary.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	when := time.Now().UTC().Add(-1 * time.Hour)

	// One canary policy (50%) and one fully-rolled-out policy (should be excluded).
	if err := db.UpsertPolicyWithRules(ctx, Policy{ID: "pc", Name: "canary pol", Enabled: true, RolloutPercent: 50}, nil); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertPolicyWithRules(ctx, Policy{ID: "pf", Name: "full pol", Enabled: true, RolloutPercent: 100}, nil); err != nil {
		t.Fatal(err)
	}
	mk := func(id, policyID, decision string) {
		if err := db.InsertPolicyDecisionEvent(ctx, PolicyDecisionEvent{ID: id, PolicyID: policyID, Decision: decision, CreatedAt: when}); err != nil {
			t.Fatal(err)
		}
	}
	mk("e1", "pc", "deny_model")    // enforced (in-slice)
	mk("e2", "pc", "canary_shadow") // shadow (out-of-slice)
	mk("e3", "pc", "canary_shadow") // shadow
	mk("e4", "pf", "deny_model")    // belongs to non-canary policy → excluded

	stats, err := db.CanaryPolicyStats(ctx, when.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 {
		t.Fatalf("only the canary policy should appear, got %d: %+v", len(stats), stats)
	}
	c := stats[0]
	if c.PolicyID != "pc" || c.EnforcedActs != 1 || c.ShadowActs != 2 {
		t.Fatalf("canary stat wrong: %+v", c)
	}
	if c.SuggestedNext != 100 {
		t.Fatalf("from 50%% the next step should be 100, got %d", c.SuggestedNext)
	}
}

func TestNextRolloutStep(t *testing.T) {
	cases := map[int]int{5: 10, 10: 25, 20: 25, 25: 50, 40: 50, 50: 100, 75: 100}
	for cur, want := range cases {
		if got := nextRolloutStep(cur); got != want {
			t.Errorf("nextRolloutStep(%d) = %d, want %d", cur, got, want)
		}
	}
}
