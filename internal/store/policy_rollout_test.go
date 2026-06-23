package store

import (
	"context"
	"path/filepath"
	"testing"

	"vibe-coders/internal/config"
)

func TestPolicyRolloutPersist(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "pol.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	// Canary policy at 25%.
	if err := db.UpsertPolicyWithRules(ctx, Policy{ID: "p_canary", Name: "canary", Enabled: true, RolloutPercent: 25}, []PolicyRule{
		{ID: "r1", Name: "deny", Enabled: true, Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"x*"}}},
	}); err != nil {
		t.Fatal(err)
	}
	// Policy with unset rollout → normalized to 100.
	if err := db.UpsertPolicyWithRules(ctx, Policy{ID: "p_full", Name: "full", Enabled: true}, []PolicyRule{
		{ID: "r2", Name: "deny2", Enabled: true, Conditions: map[string]any{}, Actions: map[string]any{"deny_models": []any{"y*"}}},
	}); err != nil {
		t.Fatal(err)
	}

	policies, err := db.ListPolicies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, p := range policies {
		got[p.ID] = p.RolloutPercent
	}
	if got["p_canary"] != 25 {
		t.Fatalf("canary rollout = %d, want 25", got["p_canary"])
	}
	if got["p_full"] != 100 {
		t.Fatalf("unset rollout should normalize to 100, got %d", got["p_full"])
	}

	// Active rules carry the owning policy's rollout percent.
	rules, err := db.ActivePolicyRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]int{}
	for _, r := range rules {
		byID[r.ID] = r.RolloutPercent
	}
	if byID["r1"] != 25 {
		t.Fatalf("rule r1 should carry rollout 25, got %d", byID["r1"])
	}
	if byID["r2"] != 100 {
		t.Fatalf("rule r2 should carry rollout 100, got %d", byID["r2"])
	}
}
