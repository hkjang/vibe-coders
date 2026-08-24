package store

import (
	"context"
	"testing"
	"time"
)

// A request's three governance phases used to be three inserts. They are one now, and the
// rows have to come out the same way regardless of how they went in.
func TestInsertPolicyDecisionEventsWritesEveryRow(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	events := []PolicyDecisionEvent{
		{ID: "e1", RequestID: "r1", APIKeyID: "k1", Endpoint: "/v1/chat/completions", Phase: "request",
			PolicyID: "p1", RuleID: "r-a", RuleName: "first", Decision: "allow", Reason: "matched",
			Model: "gpt-4.1", Provider: "openai", RiskScore: 10, ComplexityScore: 20, CostKRW: 1.5, CreatedAt: now},
		{ID: "e2", RequestID: "r1", APIKeyID: "k1", Endpoint: "/v1/chat/completions", Phase: "cost",
			PolicyID: "p1", RuleID: "r-b", RuleName: "second", Decision: "block", Reason: "over budget",
			Model: "gpt-4.1", Provider: "openai", CreatedAt: now.Add(time.Millisecond)},
		{ID: "e3", RequestID: "r1", APIKeyID: "k1", Endpoint: "/v1/chat/completions", Phase: "provider",
			PolicyID: "p1", RuleID: "r-c", RuleName: "third", Decision: "allow", CreatedAt: now.Add(2 * time.Millisecond)},
	}
	if err := db.InsertPolicyDecisionEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	got, err := db.PolicyDecisionEventsForRequest(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("wrote 3 events, read back %d: %+v", len(got), got)
	}
	byPhase := map[string]PolicyDecisionEvent{}
	for _, e := range got {
		byPhase[e.Phase] = e
	}
	for _, want := range events {
		e, ok := byPhase[want.Phase]
		if !ok {
			t.Fatalf("phase %q missing", want.Phase)
		}
		if e.ID != want.ID || e.RuleID != want.RuleID || e.Decision != want.Decision || e.RuleName != want.RuleName {
			t.Errorf("phase %q round-tripped wrong: got %+v want %+v", want.Phase, e, want)
		}
	}
	// The columns that are easy to lose in a hand-built multi-row VALUES list.
	first := byPhase["request"]
	if first.Reason != "matched" || first.Model != "gpt-4.1" || first.Provider != "openai" ||
		first.RiskScore != 10 || first.ComplexityScore != 20 || first.CostKRW != 1.5 {
		t.Errorf("a column was written into the wrong position: %+v", first)
	}
	if first.CreatedAt.IsZero() {
		t.Error("created_at was not written")
	}
}

func TestInsertPolicyDecisionEventsWithNothingToWrite(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	if err := db.InsertPolicyDecisionEvents(context.Background(), nil); err != nil {
		t.Fatalf("an empty batch must not build a statement with no VALUES: %v", err)
	}
}

// An event with no timestamp still has to land with one; the batch builds its own SQL and
// could easily drop the defaulting the single-row insert did.
func TestInsertPolicyDecisionEventsStampsMissingTimestamps(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.InsertPolicyDecisionEvents(ctx, []PolicyDecisionEvent{
		{ID: "e1", RequestID: "r-nostamp", Phase: "request", Decision: "allow"},
	}); err != nil {
		t.Fatal(err)
	}
	got, err := db.PolicyDecisionEventsForRequest(ctx, "r-nostamp")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].CreatedAt.IsZero() {
		t.Fatalf("an event without a timestamp was stored without one: %+v", got)
	}
}
