package proxy

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestComplexityBucket(t *testing.T) {
	cases := map[int]string{0: "low", 33: "low", 34: "medium", 66: "medium", 67: "high", 100: "high"}
	for score, want := range cases {
		if got := complexityBucket(score); got != want {
			t.Errorf("complexityBucket(%d) = %q, want %q", score, got, want)
		}
	}
}

func TestLearnedModelLoop(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().UTC()

	// Seed 25 successful "refactor"/high-complexity requests on claude-good and 25
	// failing ones on gpt-bad → the learner should recommend claude-good.
	seed := func(id, model string, status int, i int) {
		_ = db.InsertLogRecord(ctx, store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: model, Provider: "p", StatusCode: status, TaskType: "refactor", Complexity: 80,
				CreatedAt: now.Add(time.Duration(i) * time.Second),
			},
		})
	}
	for i := 0; i < 25; i++ {
		seed("good"+itoaProxy(i), "claude-good", 200, i)
		seed("bad"+itoaProxy(i), "gpt-bad", 500, i)
	}

	// Disabled by default → no recommendation.
	if _, _, ok := server.learnedModelFor(ctx, "refactor", 80); ok {
		t.Error("expected no learned model while the loop is disabled")
	}

	// Enable the loop and refresh the cache.
	if err := db.SetFlag(ctx, store.RuntimeFlag{Key: "routing_learning_auto", Value: "true", UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	server.invalidateLearnCache()

	model, reason, ok := server.learnedModelFor(ctx, "refactor", 80)
	if !ok {
		t.Fatal("expected a learned model once enabled")
	}
	if model != "claude-good" {
		t.Errorf("learned model = %q, want claude-good", model)
	}
	if reason == "" {
		t.Error("expected a non-empty reason")
	}
}
