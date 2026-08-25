package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestReplayFallbackImportsGoodLinesAndKeepsBadLines(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()

	fallbackPath := filepath.Join(t.TempDir(), "fallback.ndjson")
	logger := NewAsyncLogger(db, 16, fallbackPath)

	record := fallbackRecord("req_fallback_1")
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallbackPath, []byte(string(encoded)+"\n{bad-json\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stats, err := logger.FallbackStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Lines != 2 || !stats.Exists {
		t.Fatalf("unexpected fallback stats before replay: %#v", stats)
	}

	result, err := logger.ReplayFallback(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported != 1 || result.Failed != 1 || result.Remaining != 1 || result.Removed {
		t.Fatalf("unexpected replay result: %#v", result)
	}

	summary, err := db.Summary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.TotalRequests != 1 || summary.TotalTokens != 3 {
		t.Fatalf("fallback record was not imported: %#v", summary)
	}

	stats, err = logger.FallbackStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Lines != 1 {
		t.Fatalf("expected one bad line to remain, got %#v", stats)
	}
}

func TestReplayFallbackDropsDuplicateImportedRecords(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()

	fallbackPath := filepath.Join(t.TempDir(), "fallback.ndjson")
	logger := NewAsyncLogger(db, 16, fallbackPath)
	record := fallbackRecord("req_fallback_duplicate")

	if err := db.InsertLogRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallbackPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := logger.ReplayFallback(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Duplicates != 1 || !result.Removed {
		t.Fatalf("expected duplicate line to be dropped and file removed, got %#v", result)
	}
}

func openStoreForTest(t *testing.T) *SQLStore {
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		return openPostgresStoreForTest(t, dsn)
	}
	t.Helper()
	db, err := Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "gateway.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return db
}

func fallbackRecord(id string) LogRecord {
	now := time.Now().UTC()
	return LogRecord{
		Request: RequestLog{
			ID:          id,
			TraceID:     "trace_" + id,
			APIKeyID:    "anonymous",
			ClientIP:    "127.0.0.1",
			Model:       "test-model",
			Endpoint:    "/v1/chat/completions",
			Provider:    "test",
			StatusCode:  200,
			LatencyMS:   12,
			RequestHash: "hash_" + id,
			CreatedAt:   now,
		},
		Response: &ResponseLog{
			ID:           "resp_" + id,
			RequestID:    id,
			StatusCode:   200,
			FinishReason: "stop",
			ResponseHash: "resp_hash_" + id,
			CreatedAt:    now,
		},
		Usage: &TokenUsage{
			ID:               "usage_" + id,
			RequestID:        id,
			PromptTokens:     2,
			CompletionTokens: 1,
			TotalTokens:      3,
			Currency:         "KRW",
			Source:           "usage",
			CreatedAt:        now,
		},
	}
}

// openPostgresStoreForTest gives each test its own schema in one Postgres database, so
// the suite can run against the driver the product ships for production without tests
// seeing one another's rows.
func openPostgresStoreForTest(t *testing.T, dsn string) *SQLStore {
	t.Helper()
	schema := "t" + strings.ToLower(regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(t.Name(), "_"))
	if len(schema) > 55 {
		schema = schema[:55]
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	db, err := Open(context.Background(), config.DatabaseConfig{Driver: "postgres", DSN: dsn + sep + "search_path=" + schema})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate on postgres: %v", err)
	}
	return db
}
