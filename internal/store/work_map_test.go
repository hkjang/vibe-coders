package store

import (
	"context"
	"testing"
	"time"
)

func TestWorkMap(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project, apiKey, model, taskType string, status, tokens int) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: apiKey, Endpoint: "/v1/chat/completions",
				Model: model, Provider: "openai", StatusCode: status, Project: project, TaskType: taskType, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: tokens, EstimatedCost: 1, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Project "alpha": 4 reqs, 2 users, 2 models, mostly generate, one error.
	rec("a0", "alpha", "u1", "gpt-4.1", "generate", 200, 100)
	rec("a1", "alpha", "u1", "gpt-4.1", "generate", 200, 100)
	rec("a2", "alpha", "u2", "gpt-4.1", "refactor", 500, 100)
	rec("a3", "alpha", "u2", "claude-sonnet-4", "debug", 200, 100)
	// Project "beta": 1 req.
	rec("b0", "beta", "u3", "gpt-4.1-mini", "generate", 200, 50)

	nodes, err := db.WorkMap(ctx, "project", now.Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	byProj := map[string]WorkMapNode{}
	for _, n := range nodes {
		byProj[n.Subject] = n
	}
	alpha := byProj["alpha"]
	if alpha.Requests != 4 {
		t.Errorf("alpha requests = %d, want 4", alpha.Requests)
	}
	if alpha.DistinctUsers != 2 {
		t.Errorf("alpha distinct users = %d, want 2", alpha.DistinctUsers)
	}
	if alpha.DistinctModels != 2 {
		t.Errorf("alpha distinct models = %d, want 2", alpha.DistinctModels)
	}
	if alpha.Errors != 1 || alpha.ErrorRate < 0.24 || alpha.ErrorRate > 0.26 {
		t.Errorf("alpha errors=%d rate=%f, want 1 / ~0.25", alpha.Errors, alpha.ErrorRate)
	}
	if alpha.TopModel != "gpt-4.1" {
		t.Errorf("alpha top model = %q, want gpt-4.1", alpha.TopModel)
	}
	if alpha.TopTaskType != "generate" {
		t.Errorf("alpha top task type = %q, want generate", alpha.TopTaskType)
	}
	if alpha.TotalTokens != 400 {
		t.Errorf("alpha total tokens = %d, want 400", alpha.TotalTokens)
	}
	// Nodes sorted by volume desc → alpha first.
	if len(nodes) == 0 || nodes[0].Subject != "alpha" {
		t.Errorf("highest-volume node should sort first, got %+v", nodes)
	}

	// Unsupported dimension errors.
	if _, err := db.WorkMap(ctx, "bogus", now.Add(-time.Hour), 100); err == nil {
		t.Error("unsupported dimension should error")
	}
}
