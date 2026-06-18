package store

import (
	"context"
	"testing"
	"time"
)

func TestDomainRoutingDecisionSignalsExamplesAndReviewQueue(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	decision := DomainRoutingDecision{
		ID:            "drd_1",
		RequestID:     "req_1",
		UserID:        "user_1",
		TeamID:        "team_1",
		QueryHash:     "hash_1",
		Route:         "company_policy",
		Confidence:    0.91,
		ToolNames:     []string{"policy/search"},
		EvidenceScore: 0.88,
		EvidenceCount: 1,
		Reason:        "mcp evidence confirmed",
		CreatedAt:     now.Format(time.RFC3339Nano),
	}
	signals := []DomainRoutingSignal{{
		ID: "sig_1", DecisionID: decision.ID, Source: "selector", Route: decision.Route, Score: 0.91, Reason: "policy/search", CreatedAt: now.Format(time.RFC3339Nano),
	}}
	if err := db.InsertDomainRoutingDecision(ctx, decision, signals); err != nil {
		t.Fatal(err)
	}
	decisions, err := db.ListDomainRoutingDecisions(ctx, DomainRoutingFilter{Route: "company_policy", Since: now.Add(-time.Hour), Limit: 10})
	if err != nil || len(decisions) != 1 || decisions[0].ToolNames[0] != "policy/search" || decisions[0].EvidenceScore != 0.88 {
		t.Fatalf("domain decisions mismatch decisions=%+v err=%v", decisions, err)
	}
	gotSignals, err := db.DomainRoutingSignals(ctx, decision.ID)
	if err != nil || len(gotSignals) != 1 || gotSignals[0].Source != "selector" {
		t.Fatalf("domain signals mismatch signals=%+v err=%v", gotSignals, err)
	}

	example := DomainExample{
		ID: "dex_1", Route: "company_policy", Text: "vacation policy", TextHash: "text_hash", Source: "mcp_evidence",
		Confidence: 0.91, Approved: true, AutoPromoted: true, CreatedAt: now.Format(time.RFC3339Nano),
	}
	if err := db.UpsertDomainExample(ctx, example); err != nil {
		t.Fatal(err)
	}
	example.ID = "dex_2"
	example.Confidence = 0.50
	example.Approved = false
	if err := db.UpsertDomainExample(ctx, example); err != nil {
		t.Fatal(err)
	}
	examples, err := db.ListDomainExamples(ctx, "company_policy", 10)
	if err != nil || len(examples) != 1 || examples[0].Confidence != 0.91 || !examples[0].Approved || !examples[0].AutoPromoted {
		t.Fatalf("domain examples mismatch examples=%+v err=%v", examples, err)
	}

	item := DomainReviewQueueItem{
		ID: "drv_1", DecisionID: decision.ID, QueryText: "ambiguous", SuggestedRoute: "company_policy", CurrentRoute: "vibe/grounded",
		Reason: "low confidence", CreatedAt: now.Format(time.RFC3339Nano),
	}
	if err := db.EnqueueDomainReview(ctx, item); err != nil {
		t.Fatal(err)
	}
	queue, err := db.ListDomainReviewQueue(ctx, DomainRoutingFilter{Status: "pending", Limit: 10})
	if err != nil || len(queue) != 1 || queue[0].Status != "pending" {
		t.Fatalf("domain review queue mismatch queue=%+v err=%v", queue, err)
	}
	if err := db.SetDomainReviewStatus(ctx, "drv_1", "approved"); err != nil {
		t.Fatal(err)
	}
	queue, err = db.ListDomainReviewQueue(ctx, DomainRoutingFilter{Status: "approved", Limit: 10})
	if err != nil || len(queue) != 1 || queue[0].ReviewedAt == "" {
		t.Fatalf("domain review approve mismatch queue=%+v err=%v", queue, err)
	}
}
