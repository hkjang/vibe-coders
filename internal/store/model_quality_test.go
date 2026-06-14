package store

import (
	"context"
	"testing"
	"time"
)

func TestModelQualityScores(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// model A: 2 requests, both success; one eval (security pass), one eval (tests fail).
	mkReq := func(id, model string, status int) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions", Model: model, Provider: "openai", StatusCode: status, CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}
	mkEval := func(id, reqID, category string, passed bool) {
		if err := db.InsertLLMEvaluations(ctx, []LLMEvaluation{{
			ID: id, RequestID: reqID, TraceID: reqID, Name: category, Category: category, Evaluator: "ci",
			Score: 1, Passed: passed, Label: "x", CreatedAt: now,
		}}); err != nil {
			t.Fatal(err)
		}
	}

	mkReq("a1", "model-a", 200)
	mkReq("a2", "model-a", 200)
	mkEval("e1", "a1", "security", true)
	mkEval("e2", "a2", "tests", false)

	mkReq("b1", "model-b", 500) // failing model, no evals

	if err := db.UpsertGoldenPrompt(ctx, GoldenPrompt{ID: "gp", Name: "g", Prompt: "p", Expected: "ok", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertGoldenPromptResult(ctx, GoldenPromptResult{ID: "gr1", PromptID: "gp", Model: "model-a", Score: 1, Passed: true, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}

	scores, err := db.ModelQualityScores(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	byModel := map[string]ModelQualityScore{}
	for _, s := range scores {
		byModel[s.Model] = s
	}

	a, ok := byModel["model-a"]
	if !ok {
		t.Fatal("model-a missing")
	}
	if a.SuccessRate != 1 {
		t.Errorf("model-a success rate = %f, want 1", a.SuccessRate)
	}
	if a.GoldenPassRate != 1 || a.GoldenSamples != 1 {
		t.Errorf("model-a golden = %f/%d, want 1/1", a.GoldenPassRate, a.GoldenSamples)
	}
	if a.EvalSamples != 2 || a.EvalPassRate != 0.5 {
		t.Errorf("model-a eval = rate %f samples %d, want 0.5/2", a.EvalPassRate, a.EvalSamples)
	}
	if a.Categories["security"].PassRate != 1 || a.Categories["tests"].PassRate != 0 {
		t.Errorf("model-a categories unexpected: %+v", a.Categories)
	}
	// composite should be high (success 1, golden 1, eval .5, cat avg (.5)) → ~75
	if a.QualityScore < 60 || a.QualityScore > 90 {
		t.Errorf("model-a quality score = %f, want ~75", a.QualityScore)
	}

	b := byModel["model-b"]
	if b.SuccessRate != 0 {
		t.Errorf("model-b success rate = %f, want 0", b.SuccessRate)
	}
	// model-b only has the success signal (0) → composite 0.
	if b.QualityScore != 0 {
		t.Errorf("model-b quality score = %f, want 0", b.QualityScore)
	}
}
