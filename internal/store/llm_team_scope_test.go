package store

import (
	"context"
	"testing"
	"time"
)

func TestLLMRequestTeamScopeAndSessionTimeline(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC().Add(-time.Minute)

	for _, key := range []APIKeyRecord{
		{ID: "llm-scope-alpha-key", Name: "alpha", KeyHash: "alpha-hash", Team: "Alpha", Status: "active"},
		{ID: "llm-scope-beta-key", Name: "beta", KeyHash: "beta-hash", Team: "Beta", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	insertScopedLLMRequest(t, db, "llm-scope-alpha-request", "llm-scope-alpha-key", "shared-session", "alpha-prompt", now)
	insertScopedLLMRequest(t, db, "llm-scope-beta-request", "llm-scope-beta-key", "shared-session", "beta-prompt", now.Add(time.Second))
	insertScopedLLMRequest(t, db, "llm-scope-beta-only-request", "llm-scope-beta-key", "beta-only-session", "beta-only-prompt", now.Add(2*time.Second))

	unrestricted, err := db.SessionTimeline(ctx, "shared-session", 10)
	if err != nil {
		t.Fatal(err)
	}
	if unrestricted.Requests != 2 {
		t.Fatalf("legacy unrestricted timeline requests = %d, want 2", unrestricted.Requests)
	}

	alpha, err := db.SessionTimelineScoped(ctx, "shared-session", 10, []string{"Alpha"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if alpha.Requests != 1 || len(alpha.Points) != 1 || alpha.Points[0].RequestID != "llm-scope-alpha-request" {
		t.Fatalf("alpha timeline escaped team scope: %+v", alpha)
	}

	empty, err := db.SessionTimelineScoped(ctx, "shared-session", 10, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Requests != 0 || len(empty.Points) != 0 {
		t.Fatalf("empty required scope must fail closed: %+v", empty)
	}

	missing, err := db.SessionTimelineScoped(ctx, "beta-only-session", 10, []string{"Alpha"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if missing.Requests != 0 || len(missing.Points) != 0 {
		t.Fatalf("cross-team session timeline leaked: %+v", missing)
	}

	where, args := MergeLLMRequestTeamScope("r.prompt_name = ?", []any{"alpha-prompt"}, []string{"Alpha"}, true)
	sessions, err := db.LLMSessionsFilterPage(ctx, where, 10, 0, args...)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].SessionID != "shared-session" || sessions[0].Requests != 1 {
		t.Fatalf("merged LLM filter did not preserve both filters: %+v", sessions)
	}

	where, args = MergeLLMRequestTeamScope("1=1", nil, nil, true)
	sessions, err = db.LLMSessionsFilterPage(ctx, where, 10, 0, args...)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 0 {
		t.Fatalf("empty required scope returned sessions: %+v", sessions)
	}
}

func insertScopedLLMRequest(t *testing.T, db *SQLStore, requestID, apiKeyID, sessionID, promptName string, createdAt time.Time) {
	t.Helper()
	record := LogRecord{
		Request: RequestLog{
			ID: requestID, TraceID: requestID + "-trace", APIKeyID: apiKeyID,
			Endpoint: "/v1/chat/completions", Model: "scope-model", Provider: "scope-provider",
			StatusCode: 200, SessionID: sessionID, PromptName: promptName, PromptVersion: "v1", CreatedAt: createdAt,
		},
		Prompts: []PromptLog{{
			ID: requestID + "-prompt", RequestID: requestID, Role: "user",
			ContentText: promptName + " raw", RedactedText: promptName + " safe", CreatedAt: createdAt,
		}},
		Usage: &TokenUsage{
			ID: requestID + "-usage", RequestID: requestID, TotalTokens: 10,
			EstimatedCost: 1, Currency: "KRW", Source: "usage", CreatedAt: createdAt,
		},
	}
	if err := db.InsertLogRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
}
