package store

import (
	"context"
	"testing"
	"time"
)

func TestProductivityByRepo(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Now().UTC().Add(-1 * time.Hour)

	// AI usage attributed to repo "alpha".
	for i, id := range []string{"pr1", "pr2"} {
		_ = i
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai", StatusCode: 200, Repo: "alpha", CreatedAt: when},
			Usage:   &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: 5, Currency: "KRW", CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// VCS activity for "alpha": 2 commits + 1 merged MR.
	mkVCS := func(id, kind, state string) {
		if err := db.InsertVCSEvent(ctx, VCSEvent{ID: id, Provider: "gitlab", Kind: kind, Repo: "alpha", State: state, CreatedAt: when}); err != nil {
			t.Fatal(err)
		}
	}
	mkVCS("c1", "commit", "")
	mkVCS("c2", "commit", "")
	mkVCS("m1", "merge_request", "merged")

	rows, err := db.ProductivityByRepo(ctx, when.Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Repo != "alpha" {
		t.Fatalf("expected one alpha row, got %+v", rows)
	}
	r := rows[0]
	if r.AIRequests != 2 || r.AITokens != 200 || r.AICostKRW != 10 {
		t.Fatalf("AI side wrong: %+v", r)
	}
	if r.Commits != 2 || r.MergeRequests != 1 || r.Merged != 1 {
		t.Fatalf("VCS side wrong: %+v", r)
	}
}
