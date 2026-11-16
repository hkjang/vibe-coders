package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func saveExecutionTarget(t *testing.T, s *Server, id, driver, dsn string, enabled bool) {
	t.Helper()
	t.Cleanup(func() {
		s.t2sPoolMu.Lock()
		pools := s.t2sExecConns
		s.t2sExecConns = nil
		s.t2sPoolMu.Unlock()
		for _, p := range pools {
			_ = p.Close()
		}
	})
	encrypted, err := s.secrets.Load().Encrypt(dsn)
	if err != nil {
		t.Fatal("fixture encryption")
	}
	if err = s.db.UpsertText2SQLExecConnection(t.Context(), store.Text2SQLExecConnection{ID: id, Name: id, Driver: driver, EncryptedDSN: encrypted, Enabled: enabled}); err != nil {
		t.Fatal("fixture connection save")
	}
}
func sqliteExecutionSource(t *testing.T, value string) string {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "source.sqlite")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.ExecContext(t.Context(), "CREATE TABLE target(marker text); INSERT INTO target VALUES (?)", value); err != nil {
		t.Fatal(err)
	}
	return dsn
}
func assertExecutionMarker(t *testing.T, s *Server, id, want string) {
	t.Helper()
	_, rows, _, _, err := s.execText2SQL(t.Context(), id, "SELECT marker FROM target")
	if err != nil || len(rows) != 1 || len(rows[0]) != 1 || rows[0][0] != want {
		t.Fatal("execution did not use the selected current connection")
	}
}

func TestText2SQLExecutionTargetUpdatesWithoutLocalInvalidation(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite"})
	first, second := sqliteExecutionSource(t, "first"), sqliteExecutionSource(t, "second")
	saveExecutionTarget(t, s, "current", "sqlite", first, true)
	assertExecutionMarker(t, s, "current", "first")
	saveExecutionTarget(t, s, "current", "sqlite", second, true)
	assertExecutionMarker(t, s, "current", "second")
	saveExecutionTarget(t, s, "current", "sqlite", second, false)
	if _, _, _, _, err := s.execText2SQL(t.Context(), "current", "SELECT marker FROM target"); err == nil {
		t.Fatal("disabled stored connection reused an execution pool")
	}
}
func TestText2SQLExecutionTargetDeletedConnectionRejected(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite"})
	saveExecutionTarget(t, s, "deleted", "sqlite", sqliteExecutionSource(t, "first"), true)
	assertExecutionMarker(t, s, "deleted", "first")
	if err := db.DeleteText2SQLExecConnection(t.Context(), "deleted"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := s.execText2SQL(t.Context(), "deleted", "SELECT marker FROM target"); err == nil {
		t.Fatal("deleted connection reused an execution pool")
	}
}

func TestText2SQLExecutionTargetHTTPUpdateCollectAndDelete(t *testing.T) {
	s, _, httpServer := newAdminModelsTestServer(t, "")
	// The selected SQLite source must also own the schema collection dialect.
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "postgres"})
	saveExecutionTarget(t, s, "http-source", "sqlite", sqliteExecutionSource(t, "first"), true)
	assertExecutionMarker(t, s, "http-source", "first")
	old, err := s.text2sqlExecDBByID(t.Context(), "http-source")
	if err != nil {
		t.Fatal("resolve initial fixture")
	}
	update, err := json.Marshal(map[string]any{"id": "http-source", "name": "수집 연결", "driver": "sqlite", "dsn": sqliteExecutionSource(t, "second"), "enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	response, _ := req(t, http.MethodPost, httpServer.URL+"/admin/text2sql/connections", string(update))
	if response.StatusCode != http.StatusCreated {
		t.Fatal("connection update failed")
	}
	assertExecutionMarker(t, s, "http-source", "second")
	response, result := req(t, http.MethodPost, httpServer.URL+"/admin/text2sql/collect", `{"schema_name":"selected-source","connection_id":"http-source"}`)
	if response.StatusCode != http.StatusOK || result["added_tables"] != float64(1) || result["added_columns"] != float64(1) {
		t.Fatal("schema collection must use the selected current driver and pool")
	}
	response, _ = req(t, http.MethodDelete, httpServer.URL+"/admin/text2sql/connections?id=http-source", "")
	if response.StatusCode != http.StatusOK {
		t.Fatal("connection deletion failed")
	}
	if _, _, _, _, err := s.execText2SQL(t.Context(), "http-source", "SELECT marker FROM target"); err == nil {
		t.Fatal("deleted HTTP connection remained executable")
	}
	deadline := time.Now().Add(time.Second)
	for old.PingContext(t.Context()) == nil {
		if time.Now().After(deadline) {
			t.Fatal("replaced pool was not closed")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestText2SQLExecutionTargetPostgresUsesSelectedDriver(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL")
	}
	s, _, _ := newAdminModelsTestServer(t, "")
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite", StatementTimeout: 250 * time.Millisecond, WorkMem: "1MB"})
	saveExecutionTarget(t, s, "postgres-target", "postgres", dsn, true)
	_, rows, _, _, err := s.execText2SQL(t.Context(), "postgres-target", "SELECT current_setting('transaction_read_only'), current_setting('statement_timeout'), current_setting('work_mem')")
	if err != nil || len(rows) != 1 || len(rows[0]) != 3 || rows[0][0] != "on" || rows[0][1] != "250ms" || rows[0][2] != "1MB" {
		t.Fatal("selected PostgreSQL source did not use its read-only transaction and limits")
	}
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite", MaxExplainCost: 0.001})
	_, _, _, risk, err := s.execText2SQL(t.Context(), "postgres-target", "SELECT 1")
	if err == nil || risk.Score < 50 {
		t.Fatal("selected PostgreSQL source skipped configured EXPLAIN rejection")
	}
}

// Cancelled target resolution must not return an old cached connection.
func TestText2SQLExecutionTargetCancelledLookup(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	saveExecutionTarget(t, s, "cancelled", "sqlite", sqliteExecutionSource(t, "first"), true)
	if _, err := s.text2sqlExecDBByID(t.Context(), "cancelled"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.text2sqlExecDBByID(ctx, "cancelled"); err == nil {
		t.Fatal("cancelled lookup reused cached credentials")
	}
}

func TestText2SQLExecutionTargetConcurrentReuseAndRetirement(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	dsn := sqliteExecutionSource(t, "first")
	saveExecutionTarget(t, s, "shared", "sqlite", dsn, true)
	const count = 24
	results := make(chan *sql.DB, count)
	var wg sync.WaitGroup
	for range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			db, err := s.text2sqlExecDBByID(t.Context(), "shared")
			if err != nil {
				t.Error("concurrent resolution failed")
				return
			}
			results <- db
		}()
	}
	wg.Wait()
	close(results)
	var first *sql.DB
	for db := range results {
		if first == nil {
			first = db
		}
		if db != first {
			t.Fatal("concurrent requests published duplicate pools")
		}
	}
	if first == nil {
		t.Fatal("no pool resolved")
	}
	next := sqliteExecutionSource(t, "second")
	saveExecutionTarget(t, s, "shared", "sqlite", next, true)
	assertExecutionMarker(t, s, "shared", "second")
	deadline := time.Now().Add(time.Second)
	for first.PingContext(t.Context()) == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if first.PingContext(t.Context()) == nil {
		t.Fatal("retired pool stayed open")
	}
}
func TestText2SQLExecutionTargetDefaultAndTwinSnapshots(t *testing.T) {
	first, second, twin := sqliteExecutionSource(t, "first"), sqliteExecutionSource(t, "second"), sqliteExecutionSource(t, "twin")
	s := &Server{}
	t.Cleanup(func() {
		if p := s.t2sExec.Load(); p != nil {
			_ = p.Close()
		}
		if p := s.t2sTwin.Load(); p != nil {
			_ = p.Close()
		}
	})
	s.applyText2SQLRuntime(config.Text2SQLConfig{ExecDriver: "sqlite", ExecDSN: first, TwinDriver: "sqlite", TwinDSN: twin})
	for _, id := range []string{"", "default", " default "} {
		assertExecutionMarker(t, s, id, "first")
	}
	db, driver, err := s.text2sqlValidationDB()
	if err != nil || driver != "sqlite" {
		t.Fatal("twin target mismatch")
	}
	var marker string
	if db.QueryRowContext(t.Context(), "SELECT marker FROM target").Scan(&marker) != nil || marker != "twin" {
		t.Fatal("validation used execution source")
	}
	s.applyText2SQLRuntime(config.Text2SQLConfig{ExecDriver: "sqlite", ExecDSN: second})
	assertExecutionMarker(t, s, "default", "second")
	db, driver, err = s.text2sqlValidationDB()
	if err != nil || driver != "sqlite" {
		t.Fatal("validation fallback driver mismatch")
	}
	if db.QueryRowContext(t.Context(), "SELECT marker FROM target").Scan(&marker) != nil || marker != "second" {
		t.Fatal("validation retained removed twin")
	}
	s.applyText2SQLRuntime(config.Text2SQLConfig{ExecDriver: "sqlite"})
	if _, err = s.text2sqlExecDBByID(t.Context(), "default"); err == nil {
		t.Fatal("missing source became an implicit SQLite database")
	}
}
func TestText2SQLExecutionTargetMalformedReplacementRejectsCache(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	saveExecutionTarget(t, s, "replaced", "sqlite", sqliteExecutionSource(t, "first"), true)
	assertExecutionMarker(t, s, "replaced", "first")
	saveExecutionTarget(t, s, "replaced", "postgres", "postgres://user:private-target-sentinel%zz@localhost/service", true)
	if _, _, _, _, err := s.execText2SQL(t.Context(), "replaced", "SELECT marker FROM target"); err == nil || strings.Contains(err.Error(), "private-target-sentinel") {
		t.Fatal("malformed replacement reused old credentials or disclosed them")
	}
}
func TestText2SQLExecutionTargetPostgresRejectsWriteFunction(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL")
	}
	setup, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("open fixture")
	}
	defer setup.Close()
	name := fmt.Sprintf("t2s_target_probe_%d", time.Now().UnixNano())
	if _, err = setup.ExecContext(t.Context(), "CREATE SEQUENCE "+name); err != nil {
		t.Fatal("create isolated fixture sequence")
	}
	defer setup.ExecContext(context.Background(), "DROP SEQUENCE "+name)
	s, _, _ := newAdminModelsTestServer(t, "")
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite"})
	saveExecutionTarget(t, s, "protected", "postgres", dsn, true)
	if _, _, _, _, err = s.execText2SQL(t.Context(), "protected", "SELECT nextval('"+name+"')"); err == nil {
		t.Fatal("SELECT write function escaped read-only transaction")
	}
	var called bool
	if setup.QueryRowContext(t.Context(), "SELECT is_called FROM "+name).Scan(&called) != nil || called {
		t.Fatal("readonly rejection still mutated the sequence")
	}
}
