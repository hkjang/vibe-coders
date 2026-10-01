package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/config"
)

// This schema deliberately has no prompt/body/header/error/SQL/detail/hash
// columns or associated tables. Successful real queries prove they are not
// required, independently of whether the final JSON happens to hide a canary.
func openAppFlowMinimalStore(t *testing.T) *SQLStore {
	t.Helper()
	ctx := t.Context()
	cfg := config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "flow.db")}
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		parsed, err := url.Parse(dsn)
		if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
			t.Fatal("flow PostgreSQL fixture requires a URL DSN for an isolated test database")
		}
		admin, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal("open isolated PostgreSQL fixture")
		}
		var nonce [12]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			t.Fatal(err)
		}
		schema := "flow_" + hex.EncodeToString(nonce[:])
		if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
			admin.Close()
			t.Fatal("create isolated flow test schema")
		}
		t.Cleanup(func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := admin.ExecContext(cleanupCtx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
				t.Error("remove owned flow test schema")
			}
			admin.Close()
		})
		params := parsed.Query()
		params.Set("search_path", schema)
		parsed.RawQuery = params.Encode()
		cfg = config.DatabaseConfig{Driver: "postgres", DSN: parsed.String()}
	}
	db, err := Open(ctx, cfg)
	if err != nil {
		t.Fatal("open temporary flow database")
	}
	t.Cleanup(func() { db.Close() })
	for _, statement := range []string{
		`CREATE TABLE api_keys (id TEXT PRIMARY KEY, team TEXT)`,
		`CREATE TABLE request_logs (id TEXT PRIMARY KEY, api_key_id TEXT, created_at TEXT, status_code BIGINT, latency_ms BIGINT)`,
		`CREATE TABLE tool_invocations (id TEXT PRIMARY KEY, request_id TEXT, tool_name TEXT, server_label TEXT, source TEXT, created_at TEXT, is_mcp BIGINT, is_error BIGINT)`,
		`CREATE TABLE text2sql_spans (id TEXT PRIMARY KEY, request_id TEXT, stage TEXT, status TEXT, created_at TEXT, latency_ms BIGINT)`,
	} {
		if _, err := db.db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	// Use the actual declared indexes, not test-only performance indexes.
	for _, statement := range migrationStatements() {
		for _, name := range []string{"idx_request_logs_app_valid_cursor", "idx_api_keys_team_id", "idx_tool_invocations_request_id", "idx_text2sql_spans_request_id"} {
			if strings.HasPrefix(statement, "CREATE INDEX IF NOT EXISTS "+name+" ") {
				if _, err := db.db.ExecContext(ctx, renderForDialect(statement, db.dialect)); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return db
}

func appFlowExec(t *testing.T, db *SQLStore, query string, args ...any) {
	t.Helper()
	if _, err := db.db.ExecContext(t.Context(), db.bind(query), args...); err != nil {
		t.Fatal(err)
	}
}

func appFlowFixture(t *testing.T, db *SQLStore) AppRequestFlowScope {
	t.Helper()
	at := time.Date(2026, 10, 1, 1, 2, 3, 123456789, time.UTC)
	appFlowExec(t, db, `INSERT INTO api_keys(id,team) VALUES (?,?)`, "flow-key", "team-a")
	appFlowExec(t, db, `INSERT INTO request_logs(id,api_key_id,created_at,status_code,latency_ms) VALUES (?,?,?,?,?)`, "flow-root", "flow-key", formatTime(at), 200, 42)
	appFlowExec(t, db, `INSERT INTO tool_invocations(id,request_id,tool_name,server_label,source,created_at,is_mcp,is_error) VALUES (?,?,?,?,?,?,?,?)`, "tool-a", "flow-root", "lookup", "server", "call", formatTime(at.Add(-time.Nanosecond)), 1, 0)
	appFlowExec(t, db, `INSERT INTO text2sql_spans(id,request_id,stage,status,created_at,latency_ms) VALUES (?,?,?,?,?,?)`, "sql-a", "flow-root", "validate", "ok", formatTime(at.Add(time.Nanosecond)), 3)
	return AppRequestFlowScope{RequestID: "flow-root", CreatedAt: at, Teams: []string{"team-a"}, TeamScoped: true}
}

func TestAppRequestFlowForbiddenColumnsAbsent(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	ids, more, err := db.AppRequestFlowCandidates(t.Context(), scope.CreatedAt)
	if err != nil || more || len(ids) != 1 || ids[0] != scope.RequestID {
		t.Fatalf("ID-only resolver: count=%d more=%v err=%v", len(ids), more, err)
	}
	root, err := db.AppRequestFlowRoot(t.Context(), scope)
	if err != nil || root.RequestID != scope.RequestID || root.CreatedAt != appRequestFixedTime(scope.CreatedAt) || root.StatusCode == nil || *root.StatusCode != 200 || root.LatencyMS == nil || *root.LatencyMS != 42 {
		t.Fatalf("approved root query failed: %v", err)
	}
	tools, more, err := db.AppRequestFlowTools(t.Context(), scope)
	if err != nil || more || len(tools) != 1 || tools[0].ToolName != "lookup" || tools[0].IsMCP == nil || *tools[0].IsMCP != 1 {
		t.Fatalf("approved tool query: count=%d more=%v err=%v", len(tools), more, err)
	}
	spans, more, err := db.AppRequestFlowText2SQL(t.Context(), scope)
	if err != nil || more || len(spans) != 1 || spans[0].LatencyMS == nil || *spans[0].LatencyMS != 3 {
		t.Fatalf("approved T2S query: count=%d more=%v err=%v", len(spans), more, err)
	}
}

func TestAppRequestFlowQueryShapeAndDialects(t *testing.T) {
	for _, dialect := range []string{"sqlite", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := &SQLStore{dialect: dialect}
			scope := AppRequestFlowScope{RequestID: "root", CreatedAt: time.Now(), TeamScoped: true, Teams: []string{"team-a"}}
			candidate, _ := db.appRequestFlowCandidatesQuery(scope.CreatedAt)
			if !strings.HasPrefix(candidate, "SELECT r.id FROM request_logs") || strings.Contains(candidate, "api_keys") || strings.Contains(candidate, "JOIN") || strings.Contains(candidate, "ORDER BY") {
				t.Fatal("candidate query is not ID-only and global")
			}
			root, _ := db.appRequestFlowRootQuery(scope)
			tools, _ := db.appRequestFlowToolsQuery(scope)
			spans, _ := db.appRequestFlowText2SQLQuery(scope)
			for _, query := range []string{candidate, root, tools, spans} {
				for _, forbidden := range []string{"SELECT *", "prompt", "body", "header", "arg_hash", "input_hash", "output_hash", "reject_reason", "detail", "generated_sql", "response_logs", "token_usage"} {
					if strings.Contains(query, forbidden) {
						t.Fatalf("forbidden query dependency %s", forbidden)
					}
				}
				if dialect == "postgres" && (strings.Contains(query, "BLOB") || strings.Contains(query, "?")) {
					t.Fatal("unrendered PostgreSQL query")
				}
			}
			for _, query := range []string{tools, spans} {
				limitAt, scopeAt := strings.Index(query, " LIMIT "), strings.Index(query, "WHERE EXISTS")
				if limitAt < 0 || scopeAt <= limitAt || strings.Contains(query, "ORDER BY") || strings.Contains(query, "t.source =") || strings.Contains(query, "length(t.") {
					t.Fatal("child filtering/sorting moved ahead of the candidate cap")
				}
			}
		})
	}
}

func TestAppRequestFlowExactNanosecondsAndCandidateCaps(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	base := time.Date(2026, 10, 1, 1, 2, 3, 0, time.UTC)
	for index, delta := range []time.Duration{0, 120 * time.Millisecond, 123 * time.Millisecond, 123456789 * time.Nanosecond} {
		at := base.Add(delta)
		for representation, text := range []string{formatTime(at), appRequestFixedTime(at)} {
			appFlowExec(t, db, `INSERT INTO request_logs(id,created_at) VALUES (?,?)`, fmt.Sprintf("time-%d-%d", index, representation), text)
		}
		ids, more, err := db.AppRequestFlowCandidates(t.Context(), at)
		if err != nil || more || len(ids) != 2 {
			t.Fatalf("normalized timestamp %d: count=%d more=%v err=%v", index, len(ids), more, err)
		}
		ids, _, err = db.AppRequestFlowCandidates(t.Context(), at.Add(time.Nanosecond))
		if err != nil || len(ids) != 0 {
			t.Fatal("resolver rounded nanoseconds")
		}
	}
	tied := base.Add(time.Hour)
	appFlowExec(t, db, `INSERT INTO request_logs(id,created_at) VALUES (?,?)`, strings.Repeat("한", 171), formatTime(tied))
	appFlowExec(t, db, `INSERT INTO request_logs(id,created_at) VALUES (?,?)`, "", formatTime(tied))
	for count := 1; count <= AppRequestFlowCandidateLimit+1; count++ {
		appFlowExec(t, db, `INSERT INTO request_logs(id,created_at) VALUES (?,?)`, fmt.Sprintf("cap-%04d", count), formatTime(tied))
		if count < AppRequestFlowCandidateLimit-1 {
			continue
		}
		ids, more, err := db.AppRequestFlowCandidates(t.Context(), tied)
		if err != nil || len(ids) != min(count, AppRequestFlowCandidateLimit) || more != (count > AppRequestFlowCandidateLimit) {
			t.Fatalf("candidate cap %d: count=%d more=%v err=%v", count, len(ids), more, err)
		}
	}
}

func TestAppRequestFlowScopeAndRootMutation(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	assertUnavailable := func(t *testing.T, denied AppRequestFlowScope) {
		t.Helper()
		if _, err := db.AppRequestFlowRoot(t.Context(), denied); !errors.Is(err, ErrNotFound) {
			t.Fatalf("root should be unavailable: %v", err)
		}
		tools, more, err := db.AppRequestFlowTools(t.Context(), denied)
		if err != nil || more || len(tools) != 0 {
			t.Fatal("tool query escaped exact parent scope")
		}
		spans, more, err := db.AppRequestFlowText2SQL(t.Context(), denied)
		if err != nil || more || len(spans) != 0 {
			t.Fatal("T2S query escaped exact parent scope")
		}
	}
	for _, test := range []struct {
		name string
		edit func(*AppRequestFlowScope)
	}{
		{"different team", func(s *AppRequestFlowScope) { s.Teams = []string{"team-b"} }},
		{"missing team", func(s *AppRequestFlowScope) { s.Teams = nil }},
		{"different timestamp", func(s *AppRequestFlowScope) { s.CreatedAt = s.CreatedAt.Add(time.Nanosecond) }},
		{"different root", func(s *AppRequestFlowScope) { s.RequestID = "missing" }},
	} {
		t.Run(test.name, func(t *testing.T) { denied := scope; test.edit(&denied); assertUnavailable(t, denied) })
	}
	unrestricted := scope
	unrestricted.Teams, unrestricted.TeamScoped = nil, false
	if _, err := db.AppRequestFlowRoot(t.Context(), unrestricted); err != nil {
		t.Fatal(err)
	}
	appFlowExec(t, db, `UPDATE api_keys SET team=? WHERE id=?`, "team-b", "flow-key")
	assertUnavailable(t, scope)
	scope.Teams = []string{"team-b"}
	if _, err := db.AppRequestFlowRoot(t.Context(), scope); err != nil {
		t.Fatal("reassigned team should see current root")
	}
	appFlowExec(t, db, `DELETE FROM request_logs WHERE id=?`, scope.RequestID)
	assertUnavailable(t, scope)
}

func TestAppRequestFlowChildCapsPrecedeDisplayFilteringAndSorting(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	appFlowExec(t, db, `DELETE FROM tool_invocations`)
	appFlowExec(t, db, `DELETE FROM text2sql_spans`)
	if tools, more, err := db.AppRequestFlowTools(t.Context(), scope); err != nil || more || tools == nil || len(tools) != 0 {
		t.Fatal("empty tool source should be a confirmed empty bounded set")
	}
	if spans, more, err := db.AppRequestFlowText2SQL(t.Context(), scope); err != nil || more || spans == nil || len(spans) != 0 {
		t.Fatal("empty T2S source should be a confirmed empty bounded set")
	}
	// All candidates are deliberately non-display/malformed. The store must
	// retain them within its cap; the proxy must not refill to find valid rows.
	for count := 1; count <= AppRequestFlowChildLimit+1; count++ {
		id := fmt.Sprintf("candidate-%04d", count)
		appFlowExec(t, db, `INSERT INTO tool_invocations(id,request_id,source,created_at) VALUES (?,?,?,?)`, id, scope.RequestID, "declaration", "invalid-time")
		appFlowExec(t, db, `INSERT INTO text2sql_spans(id,request_id,stage,status,created_at) VALUES (?,?,?,?,?)`, id, scope.RequestID, "unknown-stage", "unknown-status", "invalid-time")
		if count < AppRequestFlowChildLimit-1 {
			continue
		}
		tools, more, err := db.AppRequestFlowTools(t.Context(), scope)
		if err != nil || len(tools) != min(count, AppRequestFlowChildLimit) || more != (count > AppRequestFlowChildLimit) {
			t.Fatalf("tool cap %d: count=%d more=%v err=%v", count, len(tools), more, err)
		}
		spans, more, err := db.AppRequestFlowText2SQL(t.Context(), scope)
		if err != nil || len(spans) != min(count, AppRequestFlowChildLimit) || more != (count > AppRequestFlowChildLimit) {
			t.Fatalf("T2S cap %d: count=%d more=%v err=%v", count, len(spans), more, err)
		}
	}
}

func TestAppRequestFlowBoundedTextAndNullableNumbers(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	huge := strings.Repeat("한", 20000)
	appFlowExec(t, db, `UPDATE request_logs SET status_code=NULL,latency_ms=NULL`)
	appFlowExec(t, db, `UPDATE tool_invocations SET id=?,tool_name=?,server_label=?,source=?,created_at=?,is_mcp=NULL,is_error=NULL`, huge, huge, huge, huge, huge)
	appFlowExec(t, db, `UPDATE text2sql_spans SET id=?,stage=?,status=?,created_at=?,latency_ms=NULL`, huge, huge, huge, huge)
	root, err := db.AppRequestFlowRoot(t.Context(), scope)
	if err != nil || root.StatusCode != nil || root.LatencyMS != nil {
		t.Fatal("NULL root numbers became known values")
	}
	tools, _, err := db.AppRequestFlowTools(t.Context(), scope)
	if err != nil || len(tools) != 1 || tools[0].IsMCP != nil || tools[0].IsError != nil {
		t.Fatal("NULL tool flags became known values")
	}
	spans, _, err := db.AppRequestFlowText2SQL(t.Context(), scope)
	if err != nil || len(spans) != 1 || spans[0].LatencyMS != nil {
		t.Fatal("NULL span duration became known")
	}
	for _, item := range []struct {
		value string
		chars int
	}{
		{tools[0].ID, 513}, {tools[0].ToolName, 257}, {tools[0].ServerLabel, 257}, {tools[0].Source, 33}, {tools[0].CreatedAt, 36},
		{spans[0].ID, 513}, {spans[0].Stage, 65}, {spans[0].Status, 33}, {spans[0].CreatedAt, 36},
	} {
		if utf8.RuneCountInString(item.value) != item.chars || len(item.value) > item.chars*4 {
			t.Fatal("database text boundary not enforced")
		}
	}
	// Invalid/out-of-range semantics remain the proxy's responsibility; the
	// store must not coalesce them to an apparently measured zero.
	appFlowExec(t, db, `UPDATE request_logs SET status_code=-1,latency_ms=?`, int64(1<<53))
	root, err = db.AppRequestFlowRoot(t.Context(), scope)
	if err != nil || root.StatusCode == nil || *root.StatusCode != -1 || root.LatencyMS == nil || *root.LatencyMS != 1<<53 {
		t.Fatal("numeric evidence was clamped or lost")
	}
	if db.dialect == "sqlite" {
		appFlowExec(t, db, `UPDATE request_logs SET status_code=?,latency_ms=1.25`, huge)
		appFlowExec(t, db, `UPDATE tool_invocations SET is_mcp=?,is_error=1.25`, huge)
		appFlowExec(t, db, `UPDATE text2sql_spans SET latency_ms=?`, huge)
		root, err = db.AppRequestFlowRoot(t.Context(), scope)
		tools, _, toolErr := db.AppRequestFlowTools(t.Context(), scope)
		spans, _, spanErr := db.AppRequestFlowText2SQL(t.Context(), scope)
		if err != nil || toolErr != nil || spanErr != nil || root.StatusCode != nil || root.LatencyMS != nil || tools[0].IsMCP != nil || tools[0].IsError != nil || spans[0].LatencyMS != nil {
			t.Fatal("malformed SQLite numeric affinity was not unknown")
		}
		// SQLite permits NULL in a legacy TEXT PRIMARY KEY. Preserve it as an
		// invalid empty candidate for the proxy to omit, not a whole-query error.
		appFlowExec(t, db, `UPDATE tool_invocations SET id=NULL`)
		appFlowExec(t, db, `UPDATE text2sql_spans SET id=NULL`)
		tools, _, toolErr = db.AppRequestFlowTools(t.Context(), scope)
		spans, _, spanErr = db.AppRequestFlowText2SQL(t.Context(), scope)
		if toolErr != nil || spanErr != nil || len(tools) != 1 || len(spans) != 1 || tools[0].ID != "" || spans[0].ID != "" {
			t.Fatal("NULL legacy child ID was not retained as an invalid bounded candidate")
		}
	}
}

func TestAppRequestFlowDatabaseErrorsAreNotEmptyResults(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.AppRequestFlowCandidates(t.Context(), scope.CreatedAt); err == nil {
		t.Fatal("candidate error became empty")
	}
	if _, err := db.AppRequestFlowRoot(t.Context(), scope); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatal("root error became not found")
	}
	if _, _, err := db.AppRequestFlowTools(t.Context(), scope); err == nil {
		t.Fatal("tool error became empty")
	}
	if _, _, err := db.AppRequestFlowText2SQL(t.Context(), scope); err == nil {
		t.Fatal("T2S error became empty")
	}
}

func TestAppRequestFlowChildTimestampPreservesOffsetNanoseconds(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	stamp := scope.CreatedAt.In(time.FixedZone("fixture-offset", 9*60*60)).Format(time.RFC3339Nano)
	if len(stamp) != 35 {
		t.Fatal("timestamp fixture must retain nine nanos digits and offset")
	}
	appFlowExec(t, db, `UPDATE tool_invocations SET created_at=?`, stamp)
	appFlowExec(t, db, `UPDATE text2sql_spans SET created_at=?`, stamp)
	tools, _, err := db.AppRequestFlowTools(t.Context(), scope)
	spans, _, spanErr := db.AppRequestFlowText2SQL(t.Context(), scope)
	if err != nil || spanErr != nil || len(tools) != 1 || len(spans) != 1 || tools[0].CreatedAt != stamp || spans[0].CreatedAt != stamp {
		t.Fatal("valid offset+nanos timestamp was truncated before projection")
	}
	appFlowExec(t, db, `UPDATE tool_invocations SET created_at=?`, stamp+"invalid-suffix")
	appFlowExec(t, db, `UPDATE text2sql_spans SET created_at=?`, stamp+"invalid-suffix")
	tools, _, err = db.AppRequestFlowTools(t.Context(), scope)
	spans, _, spanErr = db.AppRequestFlowText2SQL(t.Context(), scope)
	if err != nil || spanErr != nil || len(tools[0].CreatedAt) != 36 || len(spans[0].CreatedAt) != 36 {
		t.Fatal("oversized timestamp was not retained as max+1 invalid evidence")
	}
}

func TestAppRequestFlowCancellationAndConcurrentReads(t *testing.T) {
	db := openAppFlowMinimalStore(t)
	scope := appFlowFixture(t, db)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := db.AppRequestFlowCandidates(ctx, scope.CreatedAt); !errors.Is(err, context.Canceled) {
		t.Fatal("candidate cancellation missing")
	}
	if _, err := db.AppRequestFlowRoot(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatal("root cancellation missing")
	}
	if _, _, err := db.AppRequestFlowTools(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatal("tool cancellation missing")
	}
	if _, _, err := db.AppRequestFlowText2SQL(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatal("T2S cancellation missing")
	}
	var workers sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		workers.Go(func() {
			for round := 0; round < 5; round++ {
				if _, _, err := db.AppRequestFlowCandidates(t.Context(), scope.CreatedAt); err != nil {
					t.Error("concurrent candidates failed")
				}
				if _, err := db.AppRequestFlowRoot(t.Context(), scope); err != nil {
					t.Error("concurrent root failed")
				}
				if _, _, err := db.AppRequestFlowTools(t.Context(), scope); err != nil {
					t.Error("concurrent tools failed")
				}
				if _, _, err := db.AppRequestFlowText2SQL(t.Context(), scope); err != nil {
					t.Error("concurrent T2S failed")
				}
			}
		})
	}
	workers.Wait()
}
