package store

import (
	"context"
	"testing"
	"time"
)

func TestRecentSessionsAndRiskMarkers(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Now().UTC().Add(-30 * time.Minute)

	mkReq := func(id, sess, model string, status int, highCode bool) {
		rec := LogRecord{
			Request: RequestLog{ID: id, SessionID: sess, Endpoint: "/v1/chat/completions", Model: model, StatusCode: status, CreatedAt: when},
			Usage:   &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: 5, Currency: "KRW", CreatedAt: when},
		}
		if highCode {
			rec.CodeVerify = &CodeVerifyLog{ID: id + "_cv", RequestID: id, HasCode: true, Risk: "high", BlockCount: 1, HighCount: 1, FindingsJSON: "[]", CreatedAt: when}
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mkReq("fr1", "sessA", "gpt-4.1", 200, true)
	mkReq("fr2", "sessA", "claude-opus-4-8", 500, false)
	mkReq("fr3", "sessB", "gpt-4.1", 200, false)

	if err := db.InsertSecretEvent(ctx, SecretEvent{ID: "se1", RequestID: "fr1", SecretType: "openai_api_key", Action: "mask", CreatedAt: when}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertPolicyDecisionEvent(ctx, PolicyDecisionEvent{ID: "pd1", RequestID: "fr2", Decision: "block", CreatedAt: when}); err != nil {
		t.Fatal(err)
	}
	// An allowed decision must NOT count as a policy block.
	if err := db.InsertPolicyDecisionEvent(ctx, PolicyDecisionEvent{ID: "pd2", RequestID: "fr1", Decision: "allow", CreatedAt: when}); err != nil {
		t.Fatal(err)
	}

	sessions, err := db.RecentSessions(ctx, when.Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("want 2 sessions, got %d: %+v", len(sessions), sessions)
	}
	var a *SessionSummary
	for i := range sessions {
		if sessions[i].SessionID == "sessA" {
			a = &sessions[i]
		}
	}
	if a == nil || a.Requests != 2 || a.Models != 2 || a.Errors != 1 || a.TotalTokens != 200 {
		t.Fatalf("sessA summary wrong: %+v", a)
	}

	markers, err := db.SessionRiskMarkersFor(ctx, "sessA")
	if err != nil {
		t.Fatal(err)
	}
	if markers.Secrets["fr1"] != 1 {
		t.Fatalf("expected 1 secret event on fr1, got %v", markers.Secrets)
	}
	if markers.PolicyBlocks["fr2"] != 1 {
		t.Fatalf("expected 1 policy block on fr2, got %v", markers.PolicyBlocks)
	}
	if _, ok := markers.PolicyBlocks["fr1"]; ok {
		t.Fatalf("allow decision must not count as a block: %v", markers.PolicyBlocks)
	}
	if markers.CodeRisk["fr1"] != "high" {
		t.Fatalf("expected high code risk on fr1, got %v", markers.CodeRisk)
	}
}
