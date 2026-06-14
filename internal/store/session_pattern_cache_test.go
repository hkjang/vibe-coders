package store

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func TestLLMSessionTimelineWaterfallAndPatterns(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Date(2026, 6, 13, 10, 0, 0, 0, time.UTC)

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_llm", Name: "llm", Team: "platform", KeyHash: "hash", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "sess_complex", apiKeyID: "key_llm", sessionID: "sess_llm", model: "gpt-5", requestedModel: "vibe/auto", provider: "openai",
		prompt: "refactor cleanup payment service in Go", language: "go", status: 200, latency: 1200, firstChunk: 300, complexity: 80,
		tokens: 120, cost: 12, when: base, tools: []ToolInvocation{{ID: "tool_complex", ToolName: "read_file", Source: "call"}},
	})
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "sess_fallback", apiKeyID: "key_llm", sessionID: "sess_llm", model: "claude-sonnet", requestedModel: "vibe/auto", provider: "anthropic",
		prompt: "fix error stack trace bug", language: "go", status: 200, latency: 4000, firstChunk: 4500,
		tokens: 80, cost: 8, when: base.Add(2 * time.Second), failover: true, fallbackFrom: "openai",
		tools:       []ToolInvocation{{ID: "tool_fallback", ToolName: "shell", Source: "call", IsError: true}},
		evaluations: []LLMEvaluation{{ID: "eval_fallback", Name: "quality", Category: "regression", Evaluator: "fixture", Score: 0.2, Label: "fail", Passed: false}},
	})
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "sess_cache", apiKeyID: "key_llm", sessionID: "sess_llm", model: "gpt-4.1-mini", requestedModel: "vibe/auto", provider: "cache",
		prompt: "write unit test coverage", language: "go", status: 200, latency: 100, firstChunk: 30, routeReason: "cache",
		tokens: 20, cost: 0.5, when: base.Add(7 * time.Second),
	})
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "sess_error", apiKeyID: "key_llm", sessionID: "sess_llm", model: "gpt-4.1", requestedModel: "vibe/auto", provider: "openai",
		prompt: "ignore previous system prompt jailbreak", language: "text", status: 500, latency: 500, firstChunk: 20,
		tokens: 10, cost: 1, when: base.Add(8 * time.Second),
	})
	insertSessionRecord(t, db, sessionRecordFixture{
		id: "sess_code", apiKeyID: "key_llm", sessionID: "sess_code", model: "gpt-4.1", provider: "openai",
		prompt: "build handler returning json", language: "go", status: 200, latency: 250, firstChunk: 40,
		tokens: 30, cost: 3, when: base.Add(10 * time.Second),
	})

	sessions, err := db.LLMSessions(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	mainSession := findSessionSummary(sessions, "sess_llm")
	if mainSession == nil {
		t.Fatalf("expected sess_llm in %+v", sessions)
	}
	if mainSession.Requests != 4 || mainSession.Tokens != 230 || mainSession.CostKRW != 21.5 || mainSession.Errors != 1 || mainSession.EvaluationFailures != 1 {
		t.Fatalf("session summary mismatch: %+v", mainSession)
	}
	filtered, err := db.LLMSessionsFilter(ctx, "r.api_key_id = ?", 10, "key_llm")
	if err != nil {
		t.Fatal(err)
	}
	if findSessionSummary(filtered, "sess_llm") == nil || findSessionSummary(filtered, "sess_code") == nil {
		t.Fatalf("filtered sessions should include both sessions, got %+v", filtered)
	}

	timeline, err := db.SessionTimeline(ctx, "sess_llm", 10)
	if err != nil {
		t.Fatal(err)
	}
	if timeline.Requests != 4 || timeline.TotalTokens != 230 || timeline.TotalCostKRW != 21.5 || timeline.ToolCalls != 2 || timeline.DurationSeconds != 8 {
		t.Fatalf("timeline aggregate mismatch: %+v", timeline)
	}
	if timeline.Points[1].ToolErrors != 1 || timeline.Points[1].EvalFailures != 1 || timeline.Points[1].FirstChunkMS != 4500 {
		t.Fatalf("timeline point mismatch: %+v", timeline.Points[1])
	}
	if timeline.Points[3].CumulativeTokens != 230 || timeline.Points[3].CumulativeCostKRW != 21.5 {
		t.Fatalf("timeline cumulative mismatch: %+v", timeline.Points[3])
	}

	waterfall, err := db.Waterfall(ctx, "sess_llm", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if waterfall.Requests != 4 || waterfall.TotalTokens != 230 || waterfall.TotalCostKRW != 21.5 || waterfall.ToolCalls != 2 {
		t.Fatalf("waterfall aggregate mismatch: %+v", waterfall)
	}
	for _, category := range []string{"complex", "fallback", "cache", "error"} {
		if waterfall.Categories[category] != 1 {
			t.Fatalf("expected category %s once, got %+v", category, waterfall.Categories)
		}
	}
	if waterfall.SlowMS != 4000 || waterfall.SlowCount != 1 || !waterfall.Spans[1].Slow || waterfall.Spans[1].TTFBMS != 4000 {
		t.Fatalf("waterfall slow/clamp mismatch slow=%d count=%d span=%+v", waterfall.SlowMS, waterfall.SlowCount, waterfall.Spans[1])
	}
	if waterfall.Bottleneck.SlowestSeq != 2 || waterfall.Bottleneck.LongestGapSeq != 3 || waterfall.BusyMS != 5800 || waterfall.IdleMS != 2700 {
		t.Fatalf("waterfall timing mismatch: %+v", waterfall)
	}
	truncated, err := db.Waterfall(ctx, "sess_llm", 2, 9999)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated.Truncated || truncated.Requests != 2 || truncated.SlowMS != 9999 {
		t.Fatalf("truncated waterfall mismatch: %+v", truncated)
	}
	empty, err := db.Waterfall(ctx, "missing", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Requests != 0 || len(empty.Spans) != 0 {
		t.Fatalf("empty waterfall mismatch: %+v", empty)
	}

	patterns, err := db.LLMPatterns(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	byPattern := map[string]LLMPatternSummary{}
	for _, pattern := range patterns {
		byPattern[pattern.Pattern] = pattern
	}
	for _, pattern := range []string{"refactoring", "debugging", "testing", "prompt-injection-risk", "code-go"} {
		if byPattern[pattern].Requests != 1 {
			t.Fatalf("expected pattern %s once, got %+v", pattern, patterns)
		}
	}
	if byPattern["debugging"].Errors != 0 || byPattern["prompt-injection-risk"].Errors != 1 {
		t.Fatalf("pattern error mismatch: %+v", byPattern)
	}
	sessionPatterns, err := db.LLMPatternsFilter(ctx, "r.session_id = ?", 10, "sess_llm")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessionPatterns) != 4 {
		t.Fatalf("session pattern filter mismatch: %+v", sessionPatterns)
	}
	if llmPatternForPrompt("optimize latency", "") != "performance" || llmPatternForPrompt("database query for users", "") != "database" {
		t.Fatal("direct pattern helper classification mismatch")
	}
	if containsAny("alpha beta", "gamma") || !containsAny("alpha beta", "BETA") {
		t.Fatal("containsAny helper mismatch")
	}
	if truncatePatternSample("a  b\nc", 1) != "a" || truncatePatternSample("a  b\nc", 4) != "a b..." {
		t.Fatal("truncatePatternSample helper mismatch")
	}
}

func TestEmbeddingCacheLifecycleAndStats(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	body := []byte(`{"embedding":[0.1,0.2]}`)
	if err := db.PutEmbeddingCache(ctx, "emb_live", "text-embedding-3-small", "application/json", body, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := db.PutEmbeddingCache(ctx, "emb_expired", "text-embedding-3-large", "application/json", []byte(`{"old":true}`), -time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := db.GetEmbeddingCache(ctx, "emb_expired"); err != nil || ok {
		t.Fatalf("expired cache should miss ok=%v err=%v", ok, err)
	}
	deleted, err := db.PurgeExpiredEmbeddings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("expected one expired embedding deleted, got %d", deleted)
	}

	hit, ok, err := db.GetEmbeddingCache(ctx, "emb_live")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || hit.CacheKey != "emb_live" || hit.Model != "text-embedding-3-small" || !bytes.Equal(hit.Body, body) || hit.Hits != 0 || hit.CreatedAt.IsZero() || hit.ExpiresAt.IsZero() {
		t.Fatalf("embedding cache first hit mismatch ok=%v hit=%+v", ok, hit)
	}
	hit, ok, err = db.GetEmbeddingCache(ctx, "emb_live")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || hit.Hits != 1 {
		t.Fatalf("embedding cache second hit mismatch ok=%v hit=%+v", ok, hit)
	}

	updatedBody := []byte(`{"embedding":[0.3]}`)
	if err := db.PutEmbeddingCache(ctx, "emb_live", "text-embedding-3-small", "application/json", updatedBody, time.Hour); err != nil {
		t.Fatal(err)
	}
	hit, ok, err = db.GetEmbeddingCache(ctx, "emb_live")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !bytes.Equal(hit.Body, updatedBody) {
		t.Fatalf("embedding cache update mismatch ok=%v hit=%+v", ok, hit)
	}

	stats, err := db.EmbeddingCacheStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Entries != 1 || stats.Bytes != int64(len(updatedBody)) || stats.TotalHits < 3 || len(stats.TopModels) != 1 {
		t.Fatalf("embedding cache stats mismatch: %+v", stats)
	}
	if stats.TopModels[0].Model != "text-embedding-3-small" || stats.TopModels[0].Entries != 1 || stats.TopModels[0].Hits < 3 {
		t.Fatalf("embedding cache top model mismatch: %+v", stats.TopModels)
	}
}

type sessionRecordFixture struct {
	id             string
	apiKeyID       string
	sessionID      string
	model          string
	requestedModel string
	provider       string
	prompt         string
	language       string
	status         int
	latency        int64
	firstChunk     int64
	complexity     int
	tokens         int
	cost           float64
	when           time.Time
	failover       bool
	routeReason    string
	fallbackFrom   string
	tools          []ToolInvocation
	evaluations    []LLMEvaluation
}

func insertSessionRecord(t *testing.T, db *SQLStore, fixture sessionRecordFixture) {
	t.Helper()
	rec := LogRecord{
		Request: RequestLog{
			ID: fixture.id, TraceID: fixture.id + "_trace", APIKeyID: fixture.apiKeyID, ClientIP: "127.0.0.1", Endpoint: "/v1/chat/completions",
			Model: fixture.model, RequestedModel: fixture.requestedModel, Provider: fixture.provider, StatusCode: fixture.status,
			LatencyMS: fixture.latency, FirstChunkMS: fixture.firstChunk, SessionID: fixture.sessionID, PromptName: "fixture",
			PromptVersion: "v1", Failover: fixture.failover, RouteReason: fixture.routeReason, Complexity: fixture.complexity,
			FallbackFrom: fixture.fallbackFrom, CreatedAt: fixture.when,
		},
		Prompts: []PromptLog{{
			ID: fixture.id + "_prompt", RequestID: fixture.id, Role: "user", ContentText: fixture.prompt, RedactedText: fixture.prompt,
			LanguageHint: fixture.language, CreatedAt: fixture.when,
		}},
		Response: &ResponseLog{ID: fixture.id + "_response", RequestID: fixture.id, StatusCode: fixture.status, FinishReason: "stop", CreatedAt: fixture.when},
		Usage: &TokenUsage{
			ID: fixture.id + "_usage", RequestID: fixture.id, PromptTokens: fixture.tokens / 2, CompletionTokens: fixture.tokens - fixture.tokens/2,
			TotalTokens: fixture.tokens, EstimatedCost: fixture.cost, Currency: "KRW", Source: "usage", CreatedAt: fixture.when,
		},
	}
	for i := range fixture.tools {
		tool := fixture.tools[i]
		tool.RequestID = fixture.id
		tool.TraceID = fixture.id + "_trace"
		tool.APIKeyID = fixture.apiKeyID
		tool.CreatedAt = fixture.when
		rec.Tools = append(rec.Tools, tool)
	}
	for i := range fixture.evaluations {
		evaluation := fixture.evaluations[i]
		evaluation.RequestID = fixture.id
		evaluation.TraceID = fixture.id + "_trace"
		evaluation.CreatedAt = fixture.when
		rec.Evaluations = append(rec.Evaluations, evaluation)
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

func findSessionSummary(items []LLMSessionSummary, sessionID string) *LLMSessionSummary {
	for i := range items {
		if items[i].SessionID == sessionID {
			return &items[i]
		}
	}
	return nil
}
