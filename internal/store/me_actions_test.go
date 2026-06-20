package store

import (
	"context"
	"testing"
	"time"
)

func TestActionSnooze(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// Nothing snoozed initially.
	if m, _ := db.SnoozedActions(ctx, "u1", now); len(m) != 0 {
		t.Fatalf("expected no snoozes, got %v", m)
	}
	// Snooze key_expiry for 7 days.
	if err := db.SnoozeAction(ctx, "u1", "key_expiry", now.Add(7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	m, _ := db.SnoozedActions(ctx, "u1", now)
	if !m["key_expiry"] {
		t.Fatalf("key_expiry should be snoozed, got %v", m)
	}
	// Other user unaffected.
	if other, _ := db.SnoozedActions(ctx, "u2", now); len(other) != 0 {
		t.Fatalf("u2 should have no snoozes, got %v", other)
	}
	// Expired snooze no longer returned.
	if err := db.SnoozeAction(ctx, "u1", "cost_increase", now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	m2, _ := db.SnoozedActions(ctx, "u1", now)
	if m2["cost_increase"] {
		t.Fatalf("expired snooze must not be active: %v", m2)
	}
	// Re-snooze overwrites (upsert), still single active for key_expiry.
	if err := db.SnoozeAction(ctx, "u1", "key_expiry", now.Add(3*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if m3, _ := db.SnoozedActions(ctx, "u1", now); !m3["key_expiry"] {
		t.Fatalf("re-snooze should keep key_expiry active: %v", m3)
	}
}
