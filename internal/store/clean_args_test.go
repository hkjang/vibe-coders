package store

import (
	"context"
	"math"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestCleanArgsCleansing(t *testing.T) {
	db, err := Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "gateway_clean.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}

	record := LogRecord{
		Request: RequestLog{
			ID:        "req_clean_1",
			TraceID:   "trace_clean_1",
			Endpoint:  "chat",
			BodyRaw:   "hello\x00world", // Contains NULL byte
			Error:     "some\x00error",   // Contains NULL byte
			CreatedAt: time.Now().UTC(),
		},
		Prompts: []PromptLog{
			{
				ID:          "prompt_clean_1",
				RequestID:   "req_clean_1",
				Role:        "user",
				ContentText: "hello\x00user", // Contains NULL byte
			},
		},
		Usage: &TokenUsage{
			ID:            "usage_clean_1",
			RequestID:     "req_clean_1",
			EstimatedCost: math.NaN(), // Contains NaN
			Currency:      "KRW",
			Source:        "test",
		},
	}

	// Inserts logs ensuring no DB insertion error occurs.
	if err := db.InsertLogRecord(context.Background(), record); err != nil {
		t.Fatalf("failed to insert cleansed record: %v", err)
	}

	// Verify request_logs fields have null bytes stripped.
	var bodyRaw, errStr string
	err = db.db.QueryRow(`SELECT body_raw, error FROM request_logs WHERE id = 'req_clean_1'`).Scan(&bodyRaw, &errStr)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(bodyRaw, "\x00") {
		t.Error("body_raw still contains null byte")
	}
	if bodyRaw != "helloworld" {
		t.Errorf("unexpected body_raw: %q", bodyRaw)
	}

	if strings.Contains(errStr, "\x00") {
		t.Error("error still contains null byte")
	}

	// Verify token_usage cost is replaced with 0.0 instead of NaN.
	var cost float64
	err = db.db.QueryRow(`SELECT estimated_cost FROM token_usage WHERE id = 'usage_clean_1'`).Scan(&cost)
	if err != nil {
		t.Fatal(err)
	}

	if math.IsNaN(cost) {
		t.Error("estimated_cost is still NaN")
	}
	if cost != 0.0 {
		t.Errorf("unexpected cost: %v", cost)
	}
}

func TestCleanArgsInvalidUTF8(t *testing.T) {
	invalidStr := "hello\x8bworld"
	cleaned := cleanArgs([]any{invalidStr})
	if len(cleaned) != 1 {
		t.Fatal("expected 1 arg")
	}
	resStr, ok := cleaned[0].(string)
	if !ok {
		t.Fatal("expected string")
	}
	if strings.Contains(resStr, "\x8b") {
		t.Error("invalid UTF-8 sequence was not stripped")
	}
	if resStr != "helloworld" {
		t.Errorf("expected helloworld, got %q", resStr)
	}
}

func TestSystemErrorsStore(t *testing.T) {
	db, err := Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "gateway_errors.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	// Insert system error
	if err := db.InsertSystemError(ctx, "test_comp", "something went wrong\x8b"); err != nil {
		t.Fatal(err)
	}

	list, err := db.ListSystemErrors(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}

	if len(list) != 1 {
		t.Fatalf("expected 1 system error, got %d", len(list))
	}

	errRow := list[0]
	if errRow.Component != "test_comp" {
		t.Errorf("unexpected component: %q", errRow.Component)
	}
	if strings.Contains(errRow.ErrorMessage, "\x8b") {
		t.Error("error message still contains invalid UTF-8")
	}

	// Clear errors
	if err := db.ClearSystemErrors(ctx); err != nil {
		t.Fatal(err)
	}

	list2, err := db.ListSystemErrors(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list2) != 0 {
		t.Errorf("expected 0 system errors after clear, got %d", len(list2))
	}
}
