package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func healthcheckResult(t *testing.T, s *Server, query string) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleText2SQLHealthcheck(w, httptest.NewRequest("GET", "/admin/text2sql/healthcheck"+query, nil))
	var body map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
		t.Fatalf("unexpected healthcheck HTTP %d", w.Code)
	}
	return body
}

func TestText2SQLHealthcheckDefaultAliasWithoutDSN(t *testing.T) {
	s := &Server{cfg: config.Config{Text2SQL: config.Text2SQLConfig{ExecDriver: "sqlite"}}}
	for _, q := range []string{"", "?connection_id=default"} {
		body := healthcheckResult(t, s, q)
		if body["configured"] != false || body["status"] != "preview_only" || body["read_only_tx_ok"] != nil {
			t.Fatalf("unconfigured connection claimed a check: %v", body)
		}
	}
}

func TestText2SQLHealthcheckNoRawDatabaseError(t *testing.T) {
	s := &Server{cfg: config.Config{Text2SQL: config.Text2SQLConfig{ExecDriver: "postgres", ExecDSN: "postgres://public-fixture:private-health-sentinel@bad host/db"}}}
	body := healthcheckResult(t, s, "")
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "private-health-sentinel") || strings.Contains(string(raw), "postgres://") {
		t.Fatal("database connection secret was returned")
	}
	if body["status"] != "error" {
		t.Fatal("invalid DSN was accepted")
	}
}

func TestText2SQLHealthcheckNamedDriverAndUnknownChecks(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	encrypted, err := s.secrets.Load().Encrypt(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	err = db.UpsertText2SQLExecConnection(t.Context(), store.Text2SQLExecConnection{ID: "health-sqlite", Name: "진단", Driver: "sqlite", EncryptedDSN: encrypted, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	body := healthcheckResult(t, s, "?connection_id=health-sqlite")
	if body["driver"] != "sqlite" {
		t.Fatalf("wrong named driver: %v", body["driver"])
	}
	if body["reachable"] != true || body["read_only_tx_ok"] != nil || body["statement_timeout_ok"] != nil || body["account_write_restricted"] != nil {
		t.Fatalf("unverified sandbox reported as checked: %v", body)
	}
}

func TestText2SQLHealthcheckNamedConnectionChanges(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	encrypted, err := s.secrets.Load().Encrypt(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	conn := store.Text2SQLExecConnection{ID: "health-current", Name: "진단", Driver: "sqlite", EncryptedDSN: encrypted, Enabled: true}
	if err = db.UpsertText2SQLExecConnection(t.Context(), conn); err != nil {
		t.Fatal(err)
	}
	// A stale execution pool must not replace the connection being tested.
	stale, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer stale.Close()
	s.t2sPoolMu.Lock()
	s.t2sExecConns = map[string]*text2sqlDBPool{conn.ID: {db: stale, driver: "sqlite"}}
	s.t2sPoolMu.Unlock()
	if body := healthcheckResult(t, s, "?connection_id="+conn.ID); body["status"] != "warn" || body["query_ok"] != true {
		t.Fatal("current connection failed")
	}
	conn.Enabled = false
	if err = db.UpsertText2SQLExecConnection(t.Context(), conn); err != nil {
		t.Fatal(err)
	}
	if body := healthcheckResult(t, s, "?connection_id="+conn.ID); body["status"] != "error" || body["reachable"] != nil {
		t.Fatal("disabled connection reused cached handle")
	}
	conn.Enabled = true
	conn.EncryptedDSN = "not-a-valid-encrypted-value"
	if err = db.UpsertText2SQLExecConnection(t.Context(), conn); err != nil {
		t.Fatal(err)
	}
	if body := healthcheckResult(t, s, "?connection_id="+conn.ID); body["status"] != "error" || body["reachable"] != nil {
		t.Fatal("invalid encrypted connection reused cached handle")
	}
	if body := healthcheckResult(t, s, "?connection_id=missing"); body["detail_code"] != "connection_unavailable" {
		t.Fatal("missing connection not rejected")
	}
	if err = stale.PingContext(t.Context()); err != nil {
		t.Fatal("diagnostic closed an execution pool")
	}
}

func TestText2SQLHealthcheckPostgresCurrentDriver(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL")
	}
	s, db, _ := newAdminModelsTestServer(t, "")
	s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "sqlite", StatementTimeout: 5 * time.Second})
	encrypted, err := s.secrets.Load().Encrypt(dsn)
	if err != nil {
		t.Fatal("encrypt fixture")
	}
	conn := store.Text2SQLExecConnection{ID: "health-postgres", Name: "진단", Driver: "postgresql", EncryptedDSN: encrypted, Enabled: true}
	if err = db.UpsertText2SQLExecConnection(t.Context(), conn); err != nil {
		t.Fatal("store fixture")
	}
	for _, q := range []string{"?connection_id=health-postgres", "?connection_id=default", ""} {
		if q != "?connection_id=health-postgres" {
			s.t2sRuntime.Store(&config.Text2SQLConfig{ExecDriver: "pgx", ExecDSN: dsn, StatementTimeout: 5 * time.Second})
		}
		body := healthcheckResult(t, s, q)
		for _, field := range []string{"reachable", "query_ok", "read_only_tx_ok", "statement_timeout_ok"} {
			if body[field] != true {
				t.Fatalf("PostgreSQL %s check failed", field)
			}
		}
		if body["status"] != "ok" || body["driver"] != "postgres" || body["account_write_restricted"] != nil || body["probe_timeout"] != "1s" || body["statement_timeout"] != "5s" {
			t.Fatal("PostgreSQL diagnostics contract mismatch")
		}
	}
	audit, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audit) != 0 {
		t.Fatal("diagnostic created a mutation audit")
	}
}

func TestText2SQLHealthcheckHTTPAuthorizationAndOpenAPI(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-health-session-fixture"
	spec := buildOpenAPISpec()
	encoded, _ := json.Marshal(spec)
	var document map[string]any
	if json.Unmarshal(encoded, &document) != nil {
		t.Fatal("OpenAPI document")
	}
	assertJSONOperationSchema(t, document["paths"].(map[string]any), "/admin/text2sql/healthcheck", "get", "200", "Text2SQLHealthcheck")
	contract := text2SQLHealthcheckOpenAPISchemas()["Text2SQLHealthcheck"].(map[string]any)
	for _, tc := range []struct {
		name   string
		scopes []string
		want   int
	}{
		{"reader", []string{"admin:read"}, 200}, {"writer", []string{"admin:write"}, 401}, {"routing", []string{"routing:read"}, 401}, {"anonymous", nil, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, _ := http.NewRequest("GET", gateway.URL+"/admin/text2sql/healthcheck", nil)
			if tc.scopes != nil {
				token := issueLLMScopedTestToken(t, db, s, "health-"+tc.name, "readonly_admin", "", tc.scopes, time.Now().UTC().Add(-time.Minute))
				request.Header.Set("Authorization", "Bearer "+token)
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal("HTTP request failed")
			}
			defer response.Body.Close()
			if response.StatusCode != tc.want {
				t.Fatalf("HTTP status %d, want %d", response.StatusCode, tc.want)
			}
			if tc.want == 200 {
				if response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("diagnostic is cacheable")
				}
				var body map[string]any
				if json.NewDecoder(response.Body).Decode(&body) != nil {
					t.Fatal("response JSON")
				}
				required := contract["required"].([]string)
				if len(body) != len(required) {
					t.Fatal("response fields differ from contract")
				}
				for _, field := range required {
					if _, ok := body[field]; !ok {
						t.Fatalf("missing field %s", field)
					}
				}
			}
		})
	}
}

func TestText2SQLHealthcheckOracleRemainsSupported(t *testing.T) {
	s := &Server{cfg: config.Config{Text2SQL: config.Text2SQLConfig{ExecDriver: "oracle", ExecDSN: "oracle://public-fixture:private-health-sentinel%zz@localhost/service"}}}
	body := healthcheckResult(t, s, "")
	if body["driver"] != "oracle" || body["configured"] != true || body["detail_code"] == "unsupported_driver" {
		t.Fatal("registered Oracle driver was rejected before checking its configured connection")
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "private-health-sentinel") {
		t.Fatal("Oracle connection error disclosed credentials")
	}
}

func TestText2SQLHealthcheckOracleBasicQueryDialect(t *testing.T) {
	// SQLite validates the DUAL query shape without pretending to be an Oracle
	// server. The real registered Oracle driver's invalid-DSN path is tested above.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if text2SQLCheckBasicQuery(t.Context(), db, "oracle") {
		t.Fatal("Oracle diagnostic omitted its required DUAL source")
	}
	if _, err = db.ExecContext(t.Context(), "CREATE TABLE DUAL(dummy text); INSERT INTO DUAL VALUES ('X')"); err != nil {
		t.Fatal(err)
	}
	if !text2SQLCheckBasicQuery(t.Context(), db, "oracle") {
		t.Fatal("Oracle-shaped constant query failed")
	}
	if _, err = db.ExecContext(t.Context(), "DROP TABLE DUAL"); err != nil {
		t.Fatal(err)
	}
	if !text2SQLCheckBasicQuery(t.Context(), db, "sqlite") {
		t.Fatal("SQLite diagnostic unexpectedly requires DUAL")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if text2SQLCheckBasicQuery(ctx, db, "sqlite") {
		t.Fatal("cancelled query reported success")
	}
}
