package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPromptFingerprintsCostAndSampleAggregation(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	insertFingerprintRecord := func(id, fp, taskType, model, prompt string, status int, tokens int, cost float64, when time.Time) {
		t.Helper()
		rec := LogRecord{
			Request: RequestLog{
				ID: id, TraceID: id, APIKeyID: "key_fp", Endpoint: "/v1/chat/completions",
				Model: model, StatusCode: status, TaskType: taskType, PromptFingerprint: fp, CreatedAt: when,
			},
			Prompts: []PromptLog{{
				ID: id + "_prompt", RequestID: id, Role: "user", RedactedText: prompt, CreatedAt: when,
			}},
			Usage: &TokenUsage{
				ID: id + "_usage", RequestID: id, PromptTokens: tokens / 2, CompletionTokens: tokens - tokens/2,
				TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when,
			},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}

	insertFingerprintRecord("fp_a_1", "fp_feature", "generate", "gpt-4.1", "build endpoint\nwith validation", 200, 120, 12, now.Add(-3*time.Minute))
	insertFingerprintRecord("fp_a_2", "fp_feature", "generate", "gpt-4.1", "build endpoint again", 200, 100, 10, now.Add(-2*time.Minute))
	insertFingerprintRecord("fp_a_3", "fp_feature", "generate", "gpt-4.1-mini", "build endpoint cheaply", 200, 80, 1, now.Add(-time.Minute))
	insertFingerprintRecord("fp_b_1", "fp_debug", "debug", "gpt-4.1-mini", "fix panic", 500, 50, 1, now.Add(-time.Minute))
	insertFingerprintRecord("fp_old", "fp_ignored", "debug", "gpt-4.1", "old prompt", 200, 20, 2, now.Add(-48*time.Hour))

	stats, err := db.PromptFingerprints(ctx, now.Add(-24*time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("expected 2 recent fingerprints, got %+v", stats)
	}
	top := stats[0]
	if top.Fingerprint != "fp_feature" || top.Requests != 3 || top.TaskType != "generate" {
		t.Fatalf("unexpected top fingerprint: %+v", top)
	}
	if top.TopModel != "gpt-4.1" || top.CheapestModel != "gpt-4.1-mini" {
		t.Fatalf("model recommendations wrong: %+v", top)
	}
	if top.DistinctModels != 2 || top.TotalCostKRW != 23 || top.AvgTokens != 100 {
		t.Fatalf("cost/token aggregation wrong: %+v", top)
	}
	if top.SuccessRate != 1 {
		t.Fatalf("success rate = %.2f, want 1", top.SuccessRate)
	}
	if top.SamplePrompt != "build endpoint with validation" || strings.Contains(top.SamplePrompt, "\n") {
		t.Fatalf("sample prompt should be first user prompt flattened, got %q", top.SamplePrompt)
	}

	failing := stats[1]
	if failing.Fingerprint != "fp_debug" || failing.SuccessRate != 0 {
		t.Fatalf("failing fingerprint success rate wrong: %+v", failing)
	}
}

func TestTruncatePromptNormalizesWhitespaceAndRunes(t *testing.T) {
	got := truncatePrompt("  hello\n\nworld\r  again  ", 100)
	if got != "hello world again" {
		t.Fatalf("unexpected whitespace normalization: %q", got)
	}
	if got := truncatePrompt("가나다라마", 3); got != "가나다…" {
		t.Fatalf("unicode truncation should keep rune boundaries, got %q", got)
	}
}
