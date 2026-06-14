package store

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

func TestLLMEvaluationFeedbackAndAlignmentQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	seedLLMObservabilityFixture(t, db)

	evals, err := db.EvaluationsForRequest(ctx, "llm_r2")
	if err != nil {
		t.Fatal(err)
	}
	if len(evals) != 1 || evals[0].Name != "quality" || evals[0].Passed {
		t.Fatalf("unexpected evaluations for request: %+v", evals)
	}
	recentEvals, err := db.RecentEvaluationsFilter(ctx, "r.prompt_name = ?", 2, "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(recentEvals) != 2 || recentEvals[0].RequestID != "llm_r3" {
		t.Fatalf("recent evaluations should be newest first and filtered, got %+v", recentEvals)
	}
	allRecentEvals, err := db.RecentEvaluations(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(allRecentEvals) != 3 {
		t.Fatalf("recent evaluations wrapper returned %+v", allRecentEvals)
	}
	evalSummary, err := db.EvaluationSummaryFilter(ctx, "r.prompt_name = ?", "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(evalSummary) != 1 || evalSummary[0].Total != 3 || evalSummary[0].Passed != 1 || evalSummary[0].Failed != 2 || !floatClose(evalSummary[0].AverageScore, 0.5) {
		t.Fatalf("evaluation summary mismatch: %+v", evalSummary)
	}
	if summary, err := db.EvaluationSummary(ctx); err != nil || len(summary) != 1 {
		t.Fatalf("evaluation summary wrapper err=%v summary=%+v", err, summary)
	}

	feedback, err := db.FeedbackForRequest(ctx, "llm_r2")
	if err != nil {
		t.Fatal(err)
	}
	if len(feedback) != 1 || feedback[0].Rating >= 0 || feedback[0].Label != "wrong" {
		t.Fatalf("unexpected feedback for request: %+v", feedback)
	}
	recentFeedback, err := db.RecentLLMFeedbackFilter(ctx, "r.prompt_version = ?", 10, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(recentFeedback) != 2 || recentFeedback[0].RequestID != "llm_r2" {
		t.Fatalf("recent feedback should be newest first and filtered, got %+v", recentFeedback)
	}
	if allFeedback, err := db.RecentLLMFeedback(ctx, 10); err != nil || len(allFeedback) != 3 {
		t.Fatalf("recent feedback wrapper err=%v feedback=%+v", err, allFeedback)
	}
	feedbackSummary, err := db.LLMFeedbackSummaryFilter(ctx, "r.prompt_name = ?", "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if feedbackSummary.Total != 3 || feedbackSummary.Positive != 2 || feedbackSummary.Negative != 1 || feedbackSummary.Neutral != 0 || !floatClose(feedbackSummary.AverageRating, 1.0/3.0) {
		t.Fatalf("feedback summary mismatch: %+v", feedbackSummary)
	}
	if summary, err := db.LLMFeedbackSummary(ctx); err != nil || summary.Total != 3 {
		t.Fatalf("feedback summary wrapper err=%v summary=%+v", err, summary)
	}
	labels, err := db.LLMFeedbackLabelsFilter(ctx, "r.prompt_name = ?", 10, "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(labels) != 2 || labels[0].Label != "helpful" || labels[0].Total != 2 || labels[1].Label != "wrong" || labels[1].Negative != 1 {
		t.Fatalf("feedback label summary mismatch: %+v", labels)
	}
	if labels, err := db.LLMFeedbackLabels(ctx, 10); err != nil || len(labels) != 2 {
		t.Fatalf("feedback labels wrapper err=%v labels=%+v", err, labels)
	}
	prompts, err := db.LLMFeedbackPromptsFilter(ctx, "r.prompt_name = ?", 10, "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(prompts) != 2 || prompts[0].PromptVersion != "v1" || prompts[0].Total != 2 || prompts[1].PromptVersion != "v2" {
		t.Fatalf("feedback prompt summary mismatch: %+v", prompts)
	}
	if prompts, err := db.LLMFeedbackPrompts(ctx, 10); err != nil || len(prompts) != 2 {
		t.Fatalf("feedback prompts wrapper err=%v prompts=%+v", err, prompts)
	}

	alignment, err := db.LLMAlignmentSummaryFilter(ctx, "r.prompt_name = ?", "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if alignment.Total != 3 || alignment.Aligned != 2 || alignment.Misaligned != 1 || alignment.HumanNegativeCount != 1 || !floatClose(alignment.AlignmentRate, 2.0/3.0) {
		t.Fatalf("alignment summary mismatch: %+v", alignment)
	}
	if alignment, err := db.LLMAlignmentSummary(ctx); err != nil || alignment.Total != 3 {
		t.Fatalf("alignment summary wrapper err=%v alignment=%+v", err, alignment)
	}
	alignmentPrompts, err := db.LLMAlignmentPromptsFilter(ctx, "r.prompt_name = ?", 10, "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(alignmentPrompts) != 2 || alignmentPrompts[0].PromptVersion != "v1" || alignmentPrompts[0].Aligned != 2 || alignmentPrompts[1].PromptVersion != "v2" || alignmentPrompts[1].Misaligned != 1 {
		t.Fatalf("alignment prompt summary mismatch: %+v", alignmentPrompts)
	}
	if prompts, err := db.LLMAlignmentPrompts(ctx, 10); err != nil || len(prompts) != 2 {
		t.Fatalf("alignment prompts wrapper err=%v prompts=%+v", err, prompts)
	}
}

func TestLLMTimeseriesPromptsAndComparisonQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := seedLLMObservabilityFixture(t, db)

	hourly, err := db.LLMTimeseriesFilter(ctx, "hour", base.Add(-time.Hour), "r.prompt_name = ?", "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(hourly) != 2 {
		t.Fatalf("expected 2 hourly points, got %+v", hourly)
	}
	first := hourly[0]
	if first.Date != "2026-06-13T09" || first.Requests != 2 || first.Tokens != 150 || first.CostKRW != 15 || first.Errors != 1 ||
		!floatClose(first.AverageFirstChunkMS, 30) || first.EvaluationFailures != 1 || first.FeedbackTotal != 2 ||
		first.NegativeFeedback != 1 || first.AlignmentSamples != 2 || !floatClose(first.AlignmentRate, 1) {
		t.Fatalf("hourly first point mismatch: %+v", first)
	}
	second := hourly[1]
	if second.Date != "2026-06-13T10" || second.Requests != 1 || second.EvaluationFailures != 1 || second.AlignmentSamples != 1 || second.AlignmentRate != 0 {
		t.Fatalf("hourly second point mismatch: %+v", second)
	}
	daily, err := db.LLMTimeseries(ctx, "day", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(daily) != 1 || daily[0].Bucket != "day" || daily[0].Requests != 3 || daily[0].Tokens != 230 || !floatClose(daily[0].AlignmentRate, 2.0/3.0) {
		t.Fatalf("daily timeseries mismatch: %+v", daily)
	}

	prompts, err := db.LLMPromptsFilter(ctx, "r.prompt_name = ?", 10, "assistant")
	if err != nil {
		t.Fatal(err)
	}
	if len(prompts) != 2 || prompts[0].PromptVersion != "v1" || prompts[0].Calls != 2 || prompts[0].Tokens != 150 ||
		prompts[0].Errors != 1 || prompts[0].EvalFailures != 1 || !floatClose(prompts[0].AverageLatencyMS, 200) ||
		prompts[1].PromptVersion != "v2" || prompts[1].Calls != 1 || prompts[1].EvalFailures != 1 {
		t.Fatalf("prompt summary mismatch: %+v", prompts)
	}
	if prompts, err := db.LLMPrompts(ctx, 10); err != nil || len(prompts) != 2 {
		t.Fatalf("prompt summary wrapper err=%v prompts=%+v", err, prompts)
	}
	if comparison, err := db.LLMPromptComparisonLimit(ctx, "assistant", "v2", "", 1); err != nil || comparison.Baseline == nil {
		t.Fatalf("prompt comparison limit wrapper err=%v comparison=%+v", err, comparison)
	}
	if comparison, err := db.LLMPromptComparisonFilter(ctx, "assistant", "v2", "v1", "r.model LIKE ?", "gpt-%"); err != nil || comparison.Baseline == nil || comparison.BaselineReason != "manual" {
		t.Fatalf("prompt comparison filter wrapper err=%v comparison=%+v", err, comparison)
	}
	comparison, err := db.LLMPromptComparisonFilterLimit(ctx, "assistant", "v2", "", 2, "r.model LIKE ?", "gpt-%")
	if err != nil {
		t.Fatal(err)
	}
	if comparison.Candidate.PromptVersion != "v2" || comparison.Baseline == nil || comparison.Baseline.PromptVersion != "v1" ||
		comparison.BaselineReason != "nearest_previous_version" || len(comparison.BaselineCandidates) != 1 ||
		!floatClose(comparison.CandidateErrorRate, 0) || !floatClose(comparison.BaselineErrorRate, 0.5) ||
		!floatClose(comparison.CandidateEvalRate, 1) || !floatClose(comparison.BaselineEvalRate, 0.5) ||
		comparison.Delta.Calls != -1 || comparison.Delta.Tokens != -70 || comparison.Delta.CostKRW != -7 {
		t.Fatalf("prompt comparison mismatch: %+v", comparison)
	}
	if _, err := db.LLMPromptComparison(ctx, "", "", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("blank prompt comparison should return ErrNotFound, got %v", err)
	}
}

func TestLLMInsightsQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := seedLLMObservabilityFixture(t, db)
	insertLLMInsightTriggerRecord(t, db, base.Add(90*time.Minute))

	insights, err := db.LLMInsightsFilter(ctx, base.Add(-time.Hour), "r.prompt_name IN (?, ?)", 20, "assistant", "guard")
	if err != nil {
		t.Fatal(err)
	}
	byKind := map[string]LLMInsight{}
	for _, insight := range insights {
		byKind[insight.Kind] = insight
	}
	for _, kind := range []string{
		"evaluation_failure", "prompt_injection_risk", "missing_usage", "slow_first_chunk",
		"session_errors", "negative_human_feedback", "feedback_eval_mismatch",
	} {
		if byKind[kind].Kind == "" {
			t.Fatalf("expected insight kind %s in %+v", kind, insights)
		}
		if byKind[kind].Recommendation == "" || byKind[kind].LastSeen == "" {
			t.Fatalf("insight %s should include recommendation and last_seen: %+v", kind, byKind[kind])
		}
	}
	if byKind["slow_first_chunk"].MetricValue != 3500 {
		t.Fatalf("slow first chunk metric mismatch: %+v", byKind["slow_first_chunk"])
	}
	defaultInsights, err := db.LLMInsights(ctx, base.Add(-time.Hour), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(defaultInsights) == 0 || len(defaultInsights) > 5 {
		t.Fatalf("default insights limit mismatch: %+v", defaultInsights)
	}
}

func TestRequestDetailAssemblesTraceArtifacts(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Date(2026, 6, 13, 11, 0, 0, 0, time.UTC)
	rec := LogRecord{
		Request: RequestLog{
			ID: "detail_req", TraceID: "trace_detail", APIKeyID: "key_detail", ClientIP: "127.0.0.1",
			Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai", StatusCode: 200,
			LatencyMS: 123, FirstChunkMS: 45, SessionID: "sess_detail", PromptName: "assistant",
			PromptVersion: "v3", ToolCount: 2, CreatedAt: when,
		},
		Prompts: []PromptLog{
			{ID: "detail_p1", RequestID: "detail_req", Role: "system", RedactedText: "system prompt", LanguageHint: "text", CreatedAt: when},
			{ID: "detail_p2", RequestID: "detail_req", Role: "user", RedactedText: "call tool", LanguageHint: "go", CreatedAt: when.Add(time.Second)},
		},
		Response: &ResponseLog{
			ID: "detail_resp", RequestID: "detail_req", StatusCode: 200, FinishReason: "stop", ResponseHash: "hash", ResponseTextOptional: "ok", CreatedAt: when.Add(2 * time.Second),
		},
		Usage: &TokenUsage{
			ID: "detail_usage", RequestID: "detail_req", PromptTokens: 12, CompletionTokens: 8, TotalTokens: 20,
			EstimatedCost: 3.5, Currency: "KRW", Source: "usage", CreatedAt: when,
		},
		Languages: []LanguageStat{{
			ID: "detail_lang", RequestID: "detail_req", Language: "go", Confidence: 0.9, Evidence: "func", CreatedAt: when,
		}},
		Tools: []ToolInvocation{
			{ID: "detail_tool_def", RequestID: "detail_req", TraceID: "trace_detail", APIKeyID: "key_detail", ServerLabel: "fs", ToolName: "read_file", Source: "definition", IsMCP: true, CreatedAt: when},
			{ID: "detail_tool_call", RequestID: "detail_req", TraceID: "trace_detail", APIKeyID: "key_detail", ServerLabel: "fs", ToolName: "read_file", Source: "call", IsMCP: true, CreatedAt: when.Add(time.Second)},
			{ID: "detail_tool_result", RequestID: "detail_req", TraceID: "trace_detail", APIKeyID: "key_detail", ServerLabel: "fs", ToolName: "read_file", Source: "result", IsMCP: true, IsError: true, CreatedAt: when.Add(2 * time.Second)},
		},
		Evaluations: []LLMEvaluation{{
			ID: "detail_eval", RequestID: "detail_req", TraceID: "trace_detail", Name: "quality", Category: "managed", Evaluator: "fixture", Score: 1, Label: "pass", Passed: true, CreatedAt: when,
		}},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLLMFeedback(ctx, LLMFeedback{
		ID: "detail_feedback", RequestID: "detail_req", TraceID: "trace_detail", Rating: 1, Label: "helpful", Source: "admin", CreatedBy: "tester", CreatedAt: when,
	}); err != nil {
		t.Fatal(err)
	}

	detail, err := db.RequestDetail(ctx, "detail_req")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Request.ID != "detail_req" || detail.Request.TotalTokens != 20 || detail.Request.FinishReason != "stop" {
		t.Fatalf("request summary mismatch: %+v", detail.Request)
	}
	if len(detail.Prompts) != 2 || detail.Prompts[1].Role != "user" || detail.Response == nil || detail.Response.ResponseTextOptional != "ok" {
		t.Fatalf("prompt/response detail mismatch prompts=%+v response=%+v", detail.Prompts, detail.Response)
	}
	if len(detail.Languages) != 1 || detail.Languages[0].Language != "go" {
		t.Fatalf("languages mismatch: %+v", detail.Languages)
	}
	if len(detail.Tools) != 3 || len(detail.Spans) != 3 || detail.Spans[1].Kind != "mcp" || detail.Spans[2].Status != "error" {
		t.Fatalf("tool spans mismatch tools=%+v spans=%+v", detail.Tools, detail.Spans)
	}
	if len(detail.Evaluations) != 1 || len(detail.Feedback) != 1 {
		t.Fatalf("eval/feedback mismatch evals=%+v feedback=%+v", detail.Evaluations, detail.Feedback)
	}
	tools, err := db.ToolsForRequest(ctx, "detail_req")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 3 || tools[2].Source != "result" {
		t.Fatalf("tools for request mismatch: %+v", tools)
	}
	if _, err := db.RequestDetail(ctx, "missing_req"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing request detail should return ErrNotFound, got %v", err)
	}
}

func seedLLMObservabilityFixture(t *testing.T, db *SQLStore) time.Time {
	t.Helper()
	base := time.Date(2026, 6, 13, 9, 0, 0, 0, time.UTC)
	insertLLMObsRecord(t, db, "llm_r1", "assistant", "v1", "gpt-4.1", 200, 100, 20, 100, 10, true, 0.9, 1, "helpful", base.Add(5*time.Minute))
	insertLLMObsRecord(t, db, "llm_r2", "assistant", "v1", "gpt-4.1", 500, 300, 40, 50, 5, false, 0.2, -1, "wrong", base.Add(20*time.Minute))
	insertLLMObsRecord(t, db, "llm_r3", "assistant", "v2", "gpt-4.1-mini", 200, 80, 30, 80, 8, false, 0.4, 1, "helpful", base.Add(70*time.Minute))
	return base
}

func insertLLMObsRecord(t *testing.T, db *SQLStore, id, promptName, promptVersion, model string, status int, latencyMS int64, firstChunkMS int64, tokens int, cost float64, evalPassed bool, evalScore float64, feedbackRating int, feedbackLabel string, when time.Time) {
	t.Helper()
	ctx := context.Background()
	rec := LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id + "_trace", APIKeyID: "key_llm", Endpoint: "/v1/chat/completions",
			Model: model, StatusCode: status, LatencyMS: latencyMS, FirstChunkMS: firstChunkMS,
			PromptName: promptName, PromptVersion: promptVersion, CreatedAt: when,
		},
		Prompts: []PromptLog{{
			ID: id + "_prompt", RequestID: id, Role: "user", RedactedText: promptName + " " + promptVersion, CreatedAt: when,
		}},
		Usage: &TokenUsage{
			ID: id + "_usage", RequestID: id, PromptTokens: tokens / 2, CompletionTokens: tokens - tokens/2,
			TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when,
		},
		Evaluations: []LLMEvaluation{{
			ID: id + "_eval", RequestID: id, TraceID: id + "_trace", Name: "quality", Category: "managed",
			Evaluator: "fixture", Score: evalScore, Label: "quality", Passed: evalPassed, CreatedAt: when.Add(time.Second),
		}},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLLMFeedback(ctx, LLMFeedback{
		ID: id + "_feedback", RequestID: id, TraceID: id + "_trace", Rating: feedbackRating,
		Label: feedbackLabel, Comment: feedbackLabel + " comment", Source: "admin", CreatedBy: "tester",
		CreatedAt: when.Add(2 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
}

func insertLLMInsightTriggerRecord(t *testing.T, db *SQLStore, when time.Time) {
	t.Helper()
	ctx := context.Background()
	rec := LogRecord{
		Request: RequestLog{
			ID: "llm_guard", TraceID: "llm_guard_trace", APIKeyID: "key_llm", Endpoint: "/v1/chat/completions",
			Model: "gpt-5", Provider: "openai", StatusCode: 200, LatencyMS: 4000, FirstChunkMS: 3500,
			SessionID: "sess_guard", PromptName: "guard", PromptVersion: "v1", CreatedAt: when,
		},
		Usage: &TokenUsage{
			ID: "llm_guard_usage", RequestID: "llm_guard", TotalTokens: 10, EstimatedCost: 1, Currency: "KRW", Source: "estimated", CreatedAt: when,
		},
		Evaluations: []LLMEvaluation{
			{ID: "llm_guard_injection", RequestID: "llm_guard", TraceID: "llm_guard_trace", Name: "prompt.injection", Category: "security", Evaluator: "fixture", Score: 0, Label: "fail", Passed: false, CreatedAt: when.Add(time.Second)},
			{ID: "llm_guard_usage_eval", RequestID: "llm_guard", TraceID: "llm_guard_trace", Name: "cost.has_usage", Category: "cost", Evaluator: "fixture", Score: 0, Label: "missing", Passed: false, CreatedAt: when.Add(2 * time.Second)},
		},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}
}

func floatClose(got, want float64) bool {
	return math.Abs(got-want) < 0.000001
}
