package store

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

var requestMetadataIndexNames = []string{
	"idx_api_keys_team_id", "idx_request_logs_app_valid_cursor", "idx_request_logs_app_team_valid_cursor",
	"idx_request_logs_app_trace_valid_cursor", "idx_token_usage_request_latest", "idx_response_logs_request_latest",
}

func insertEscapedRequestMetadata(t *testing.T, db *SQLStore) {
	t.Helper()
	key := APIKeyRecord{ID: `key\n`, Name: "test key", KeyHash: "test-only-hash", Team: `C:\team`}
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal(err)
	}
	record := fallbackRecord(`request\n`)
	record.Request.TraceID, record.Request.APIKeyID = `C:\trace`, key.ID
	record.Usage.ID, record.Response.ID = `usage\n`, `response\n`
	if err := db.InsertLogRecord(t.Context(), record); err != nil {
		t.Fatal(err)
	}
}

func TestAppRequestMetadataPreIndexUpgrade(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for _, name := range requestMetadataIndexNames {
		if _, err := db.db.ExecContext(t.Context(), "DROP INDEX "+name); err != nil {
			t.Fatal(err)
		}
	}
	insertEscapedRequestMetadata(t, db)
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("upgrade metadata recorded before partial indexes", err)
	}
	rows, more, err := db.AppRecentRequests(t.Context(), AppRequestFilter{Limit: 25, TraceID: `C:\trace`, Teams: []string{`C:\team`}, TeamScoped: true})
	if err != nil || more || len(rows) != 1 || rows[0].RequestID != `request\n` || rows[0].TotalTokens != 3 {
		t.Fatalf("upgraded page: count=%d more=%v error=%v", len(rows), more, err)
	}
}

func TestAppRequestMetadataPostgresUpgrade(t *testing.T) {
	if os.Getenv("TEST_POSTGRES_DSN") == "" {
		t.Skip("PostgreSQL expression index/statistics upgrade")
	}
	db := openStoreForTest(t)
	defer db.Close()
	for _, name := range requestMetadataIndexNames {
		if _, err := db.db.ExecContext(t.Context(), "DROP INDEX "+name); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, statement := range migrationStatements() {
			if strings.HasPrefix(statement, "CREATE INDEX IF NOT EXISTS "+name+" ") {
				// Recreate the previous released declaration, including its BYTEA guard.
				if _, err := db.db.ExecContext(t.Context(), strings.ReplaceAll(statement, "BLOB", "BYTEA")); err != nil {
					t.Fatal(err)
				}
				found = true
			}
		}
		if !found {
			t.Fatalf("missing previous index declaration %s", name)
		}
	}
	for _, statement := range []string{
		`CREATE STATISTICS IF NOT EXISTS app_request_guard_stats_v1 ON (length(CAST(id AS BYTEA))), (length(created_at)) FROM request_logs`,
		`CREATE STATISTICS IF NOT EXISTS app_request_guard_stats_v2 ON (length(CAST(id AS BYTEA))), (length(created_at)), (length(CAST(api_key_id AS BYTEA))) FROM request_logs`,
		`CREATE STATISTICS IF NOT EXISTS app_request_key_guard_stats_v1 ON (length(CAST(id AS BYTEA))), (length(CAST(team AS BYTEA))) FROM api_keys`,
	} {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	indexIDs := func() map[string]int64 {
		ids := map[string]int64{}
		for _, name := range append(append([]string{}, requestMetadataIndexNames...), "idx_request_logs_created_at") {
			var id int64
			if err := db.db.QueryRowContext(t.Context(), `SELECT c.oid::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1`, name).Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids[name] = id
		}
		return ids
	}
	before := indexIDs()
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("replace previous metadata guards", err)
	}
	after := indexIDs()
	for _, name := range requestMetadataIndexNames {
		if before[name] == after[name] {
			t.Errorf("previous BYTEA partial index not replaced: %s", name)
		}
	}
	if before["idx_request_logs_created_at"] != after["idx_request_logs_created_at"] {
		t.Fatal("unrelated valid index was replaced")
	}
	insertEscapedRequestMetadata(t, db)
	for _, table := range []string{"request_logs", "api_keys"} {
		if _, err := db.db.ExecContext(t.Context(), "ANALYZE "+table); err != nil {
			t.Fatal("old expression statistics still parse literal text as BYTEA", err)
		}
	}
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal("repeat metadata upgrade", err)
	}
	if !reflect.DeepEqual(after, indexIDs()) {
		t.Fatal("repeat migration rebuilt valid indexes")
	}
}

func TestAppRequestMetadataTextBytes(t *testing.T) {
	for _, field := range []string{"request_id", "trace_id", "key_id", "team", "usage_id", "response_id"} {
		for _, sample := range []struct {
			name, value string
			bounded     bool
		}{
			{"literal_escape", `value\n`, true},
			{"windows_path", `C:\trace\request`, true},
			{"hex_text", `\x6162`, true},
			{"hex_over_bytes", `\x` + strings.Repeat("61", 256), false},
			{"unicode_boundary", strings.Repeat("가", 170) + "ab", true},
			{"unicode_over_bytes", strings.Repeat("가", 171), false},
		} {
			t.Run(field+"/"+sample.name, func(t *testing.T) {
				db := openStoreForTest(t)
				defer db.Close()
				record := fallbackRecord("request-normal")
				key := APIKeyRecord{ID: "key-normal", Name: "test key", KeyHash: "test-only-hash", Team: "team-normal"}
				switch field {
				case "request_id":
					record.Request.ID = sample.value
				case "trace_id":
					record.Request.TraceID = sample.value
				case "key_id":
					key.ID = sample.value
				case "team":
					key.Team = sample.value
				case "usage_id":
					record.Usage.ID = sample.value
				case "response_id":
					record.Response.ID = sample.value
				}
				record.Request.APIKeyID = key.ID
				record.Usage.RequestID = record.Request.ID
				record.Response.RequestID = record.Request.ID
				if err := db.UpsertAPIKey(t.Context(), key); err != nil {
					t.Fatal("store literal key metadata", err)
				}
				if err := db.InsertLogRecord(t.Context(), record); err != nil {
					t.Fatal("store literal request and child metadata", err)
				}
				filter := AppRequestFilter{Limit: 25, TraceID: record.Request.TraceID, Teams: []string{key.Team}, TeamScoped: true}
				rows, more, err := db.AppRecentRequests(t.Context(), filter)
				if err != nil || more {
					t.Fatalf("query literal metadata: more=%v error=%v", more, err)
				}
				wantRow := sample.bounded || field == "usage_id" || field == "response_id"
				if !wantRow {
					if len(rows) != 0 {
						t.Fatal("over-byte identity entered bounded request page")
					}
					return
				}
				if len(rows) != 1 || rows[0].RequestID != record.Request.ID {
					t.Fatalf("literal request page count=%d", len(rows))
				}
				wantTokens, wantFinish := 3, "stop"
				if !sample.bounded && field == "usage_id" {
					wantTokens = 0
				}
				if !sample.bounded && field == "response_id" {
					wantFinish = ""
				}
				if rows[0].TotalTokens != wantTokens || rows[0].FinishReason != wantFinish {
					t.Fatalf("bounded children: tokens=%d finish=%q", rows[0].TotalTokens, rows[0].FinishReason)
				}
				if sample.bounded {
					ids, more, err := db.AppRequestFlowCandidates(t.Context(), record.Request.CreatedAt)
					if err != nil || more || len(ids) != 1 || ids[0] != record.Request.ID {
						t.Fatalf("literal flow candidates: count=%d more=%v error=%v", len(ids), more, err)
					}
					root, err := db.AppRequestFlowRoot(t.Context(), AppRequestFlowScope{RequestID: record.Request.ID, CreatedAt: record.Request.CreatedAt, Teams: []string{key.Team}, TeamScoped: true})
					if err != nil || root.RequestID != record.Request.ID {
						t.Fatal("literal team-scoped flow root", err)
					}
					for _, teams := range [][]string{{key.Team}, {"other-team"}} {
						io, err := db.RequestIOSamples(t.Context(), RequestIOSampleFilter{IDs: []string{record.Request.ID}, Teams: teams, TeamScoped: true})
						if err != nil || (len(io) == 1) != (teams[0] == key.Team) {
							t.Fatalf("literal input/output team scope: count=%d error=%v", len(io), err)
						}
					}
				}
				if db.dialect == "postgres" {
					for _, table := range []string{"request_logs", "api_keys"} {
						if _, err := db.db.ExecContext(t.Context(), fmt.Sprintf("ANALYZE %s", table)); err != nil {
							t.Fatal("literal metadata planner statistics", err)
						}
					}
				}
			})
		}
	}
}
