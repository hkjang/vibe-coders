package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestAdminTracePathIDContract(t *testing.T) {
	maximum := strings.Repeat("t", adminTracePathIDMaxBytes)
	for _, test := range []struct {
		name   string
		path   string
		prefix string
		suffix string
		want   string
		valid  bool
	}{
		{name: "trace maximum", path: "/admin/traces/" + maximum, prefix: "/admin/traces/", want: maximum, valid: true},
		{name: "llm legacy maximum", path: "/admin/llm/traces/" + maximum, prefix: "/admin/llm/traces/", want: maximum, valid: true},
		{name: "request waterfall maximum", path: "/admin/requests/" + maximum + "/trace", prefix: "/admin/requests/", suffix: "/trace", want: maximum, valid: true},
		{name: "empty", path: "/admin/traces/", prefix: "/admin/traces/"},
		{name: "dot", path: "/admin/traces/.", prefix: "/admin/traces/"},
		{name: "dot dot", path: "/admin/traces/..", prefix: "/admin/traces/"},
		{name: "literal slash", path: "/admin/traces/team/trace", prefix: "/admin/traces/"},
		{name: "control", path: "/admin/traces/trace\nnext", prefix: "/admin/traces/"},
		{name: "nul", path: "/admin/traces/trace\x00next", prefix: "/admin/traces/"},
		{name: "invalid utf8", path: "/admin/traces/" + string([]byte{0xff}), prefix: "/admin/traces/"},
		{name: "too long", path: "/admin/traces/" + strings.Repeat("t", adminTracePathIDMaxBytes+1), prefix: "/admin/traces/"},
		{name: "wrong prefix", path: "/admin/requests/request/trace", prefix: "/admin/traces/"},
		{name: "missing suffix", path: "/admin/requests/request", prefix: "/admin/requests/", suffix: "/trace"},
		{name: "nested before suffix", path: "/admin/requests/a/b/trace", prefix: "/admin/requests/", suffix: "/trace"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, valid := adminTracePathID(test.path, test.prefix, test.suffix)
			if valid != test.valid || got != test.want {
				t.Fatalf("adminTracePathID(%q) = (%q, %v), want (%q, %v)", test.path, got, valid, test.want, test.valid)
			}
		})
	}
}

func TestAdminTraceHandlersRejectMethodsAndInvalidIDsBeforeDatabaseAccess(t *testing.T) {
	server := &Server{}
	for _, test := range []struct {
		name    string
		method  string
		path    string
		handler func(http.ResponseWriter, *http.Request)
		want    int
	}{
		{name: "trace method", method: http.MethodPost, path: "/admin/traces/trace-1", handler: server.handleTraceByID, want: http.StatusMethodNotAllowed},
		{name: "trace nested id", method: http.MethodGet, path: "/admin/traces/a/b", handler: server.handleTraceByID, want: http.StatusBadRequest},
		{name: "trace encoded slash", method: http.MethodGet, path: "/admin/traces/a%2Fb", handler: server.handleTraceByID, want: http.StatusBadRequest},
		{name: "llm method", method: http.MethodPost, path: "/admin/llm/traces/request-1", handler: server.handleLLMTraceDetail, want: http.StatusMethodNotAllowed},
		{name: "llm invalid id", method: http.MethodGet, path: "/admin/llm/traces/a/b", handler: server.handleLLMTraceDetail, want: http.StatusBadRequest},
		{name: "request method", method: http.MethodPost, path: "/admin/requests/request-1/trace", handler: server.handleRequestTrace, want: http.StatusMethodNotAllowed},
		{name: "request invalid id", method: http.MethodGet, path: "/admin/requests/a/b/trace", handler: server.handleRequestTrace, want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, test.path, nil)
			test.handler(recorder, request)
			if recorder.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, test.want, recorder.Body.String())
			}
		})
	}
}

func TestAdminTraceServeMuxRejectsEscapedPathSeparators(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	for _, path := range []string{
		"/admin/traces/a%2Fb",
		"/admin/llm/traces/a%2Fb",
		"/admin/requests/a%2Fb/trace",
	} {
		response, err := http.Get(gateway.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("GET %s status=%d, want %d", path, response.StatusCode, http.StatusBadRequest)
		}
	}
}

func TestAdminTraceQueryFailuresUseStableFailClosedError(t *testing.T) {
	for _, table := range []string{"request_logs", "workflow_runs", "ai_app_runs", "code_verify_results"} {
		t.Run(table, func(t *testing.T) {
			databasePath := filepath.Join(t.TempDir(), "trace-errors.db")
			db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: databasePath})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			if err := db.Migrate(t.Context()); err != nil {
				t.Fatal(err)
			}
			_, gateway := serveAdminModelsTestStore(t, "", db)

			raw, err := sql.Open("sqlite", databasePath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.ExecContext(t.Context(), "DROP TABLE "+table); err != nil {
				raw.Close()
				t.Fatal(err)
			}
			if err := raw.Close(); err != nil {
				t.Fatal(err)
			}

			response, err := http.Get(gateway.URL + "/admin/traces/trace-db-failure")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body struct {
				Error struct {
					Message string `json:"message"`
					Code    string `json:"code"`
				} `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusInternalServerError || body.Error.Code != "trace_query_failed" || body.Error.Message != "trace query failed" {
				t.Fatalf("status=%d error=%+v", response.StatusCode, body.Error)
			}
		})
	}
}

func TestLegacyTraceHandlersDoNotExposeDatabaseErrors(t *testing.T) {
	for _, test := range []struct {
		name    string
		path    string
		code    string
		message string
	}{
		{name: "llm list", path: "/admin/llm/traces", code: "llm_traces_failed", message: "trace list query failed"},
		{name: "llm detail", path: "/admin/llm/traces/request-db-failure", code: "llm_trace_detail_failed", message: "trace detail query failed"},
		{name: "request waterfall", path: "/admin/requests/request-db-failure/trace", code: "trace_failed", message: "request trace query failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			databasePath := filepath.Join(t.TempDir(), "legacy-trace-errors.db")
			db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: databasePath})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			if err := db.Migrate(t.Context()); err != nil {
				t.Fatal(err)
			}
			_, gateway := serveAdminModelsTestStore(t, "", db)

			raw, err := sql.Open("sqlite", databasePath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.ExecContext(t.Context(), "DROP TABLE request_logs"); err != nil {
				raw.Close()
				t.Fatal(err)
			}
			if err := raw.Close(); err != nil {
				t.Fatal(err)
			}

			response, err := http.Get(gateway.URL + test.path)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			var decoded struct {
				Error struct {
					Message string `json:"message"`
					Code    string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body, &decoded); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusInternalServerError || decoded.Error.Code != test.code || decoded.Error.Message != test.message {
				t.Fatalf("status=%d error=%+v body=%s", response.StatusCode, decoded.Error, body)
			}
			if strings.Contains(strings.ToLower(string(body)), "request_logs") || strings.Contains(strings.ToLower(string(body)), "no such table") {
				t.Fatalf("database detail leaked: %s", body)
			}
		})
	}
}

func TestTeamScopedTraceListsFailClosedWhenTeamIdentityLookupFails(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "team-scope-errors.db")
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: databasePath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "team-scope-errors.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "team-scope-errors-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.InsertAuthSession(t.Context(), "team-scope-errors-session", "team-scope-errors-user", "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	token, err := server.signAccessToken(accessClaims{
		Subject: "team-scope-errors-user", Role: "team_admin", TeamID: "team-alpha",
		Scopes: []string{"admin:read"}, SessionID: "team-scope-errors-session",
		Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	raw, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(t.Context(), "DROP TABLE teams"); err != nil {
		raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name    string
		path    string
		app     bool
		code    string
		message string
	}{
		{name: "React requests", path: "/admin/requests", app: true, code: "requests_failed", message: "요청 목록을 불러오지 못했습니다."},
		{name: "LLM traces", path: "/admin/llm/traces", code: "llm_traces_failed", message: "trace list query failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, gateway.URL+test.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+token)
			if test.app {
				request.Header.Set("X-Vibe-UI", "app")
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body struct {
				Error struct {
					Message string `json:"message"`
					Code    string `json:"code"`
				} `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusInternalServerError || body.Error.Code != test.code || body.Error.Message != test.message {
				t.Fatalf("status=%d error=%+v", response.StatusCode, body.Error)
			}
		})
	}
}

func TestAdminTraceRequestLinksEscapeLegacyPathSegments(t *testing.T) {
	db := openTestStore(t)
	const requestID = "legacy?request#part%value"
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: requestID, TraceID: "trace-link", Endpoint: "/v1/chat/completions",
		StatusCode: http.StatusOK, CreatedAt: time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC),
	}}); err != nil {
		t.Fatal(err)
	}
	_, gateway := serveAdminModelsTestStore(t, "", db)

	response, err := http.Get(gateway.URL + "/admin/traces/trace-link")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Requests []struct {
			Trace string `json:"trace"`
		} `json:"requests"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	want := "/admin/requests/" + url.PathEscape(requestID) + "/trace"
	if response.StatusCode != http.StatusOK || len(body.Requests) != 1 || body.Requests[0].Trace != want {
		t.Fatalf("status=%d requests=%+v want link=%q", response.StatusCode, body.Requests, want)
	}
	linked, err := http.Get(gateway.URL + body.Requests[0].Trace)
	if err != nil {
		t.Fatal(err)
	}
	linked.Body.Close()
	if linked.StatusCode != http.StatusOK {
		t.Fatalf("escaped trace link status=%d", linked.StatusCode)
	}
}

func TestTraceDetailRedactionAndPrivilegedPreservation(t *testing.T) {
	db, gateway := newAuthTestServer(t, "http://example.invalid")
	defer gateway.Close()

	login := func(email, password string) string {
		t.Helper()
		response := postJSON(t, gateway.URL+"/auth/login", "", map[string]string{"email": email, "password": password})
		defer response.Body.Close()
		var tokens struct {
			AccessToken string `json:"access_token"`
		}
		if err := json.NewDecoder(response.Body).Decode(&tokens); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || tokens.AccessToken == "" {
			t.Fatalf("login %s status=%d token=%q", email, response.StatusCode, tokens.AccessToken)
		}
		return tokens.AccessToken
	}
	rootToken := login("root@example.com", "correct-password")
	createRole := func(role string) string {
		t.Helper()
		email := role + "-trace@example.com"
		password := "trace-password-" + role
		response := postJSON(t, gateway.URL+"/admin/users", rootToken, map[string]string{
			"email": email, "password": password, "role": role,
		})
		response.Body.Close()
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("create %s status=%d", role, response.StatusCode)
		}
		return login(email, password)
	}
	readonlyToken := createRole("readonly_admin")
	adminToken := createRole("admin")
	securityToken := createRole("security_admin")

	const (
		requestID    = "trace-sensitive-request"
		promptRaw    = "prompt belongs to prompt-sensitive@example.com"
		responseRaw  = "response belongs to response-sensitive@example.com"
		errorRaw     = "upstream failed for error-sensitive@example.com"
		fallbackRaw  = "fallback failed for fallback-sensitive@example.com"
		rejectRaw    = "SQL rejected for reject-sensitive@example.com"
		userAgentRaw = "trace-client user-agent-sensitive@example.com"
	)
	createdAt := time.Date(2026, 9, 4, 3, 4, 5, 0, time.UTC)
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: "trace-sensitive", Method: http.MethodPost,
			Endpoint: "/v1/chat/completions", Model: "test-model", StatusCode: http.StatusBadGateway,
			Error: errorRaw, Failover: true, FallbackFrom: "primary", FallbackReason: fallbackRaw,
			UserAgent: userAgentRaw,
			LatencyMS: 123, CreatedAt: createdAt,
		},
		Prompts: []store.PromptLog{{
			ID: "prompt-sensitive", RequestID: requestID, Role: "user",
			ContentText: promptRaw, RedactedText: promptRaw, CreatedAt: createdAt,
		}},
		Response: &store.ResponseLog{
			ID: "response-sensitive", RequestID: requestID, StatusCode: http.StatusBadGateway,
			ResponseTextOptional: responseRaw, CreatedAt: createdAt,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertText2SQLSpans(t.Context(), []store.Text2SQLSpan{{
		ID: "text2sql-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
		Stage: "validate", Status: "error", RejectReason: rejectRaw, CreatedAt: createdAt,
	}}); err != nil {
		t.Fatal(err)
	}

	getBody := func(token, path string) string {
		t.Helper()
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, response.StatusCode, body)
		}
		return string(body)
	}
	paths := []string{
		"/admin/llm/traces?limit=10",
		"/admin/llm/traces/" + requestID,
		"/admin/requests/" + requestID + "/trace",
	}
	for _, path := range paths {
		body := getBody(readonlyToken, path)
		for _, sensitive := range []string{promptRaw, responseRaw, errorRaw, fallbackRaw, rejectRaw, userAgentRaw} {
			if strings.Contains(body, sensitive) {
				t.Fatalf("lower-privilege response %s exposed %q: %s", path, sensitive, body)
			}
		}
		if !strings.Contains(body, "[REDACTED_EMAIL]") {
			t.Fatalf("lower-privilege response %s did not apply audit redaction: %s", path, body)
		}
	}
	for role, token := range map[string]string{
		"super_admin": rootToken,
		"admin":       adminToken,
		"security":    securityToken,
	} {
		llmBody := getBody(token, "/admin/llm/traces/"+requestID)
		for _, original := range []string{promptRaw, responseRaw, errorRaw, fallbackRaw, rejectRaw, userAgentRaw} {
			if !strings.Contains(llmBody, original) {
				t.Fatalf("%s lost raw trace detail %q: %s", role, original, llmBody)
			}
		}
		waterfallBody := getBody(token, "/admin/requests/"+requestID+"/trace")
		for _, original := range []string{errorRaw, rejectRaw} {
			if !strings.Contains(waterfallBody, original) {
				t.Fatalf("%s lost raw waterfall detail %q: %s", role, original, waterfallBody)
			}
			listBody := getBody(token, "/admin/llm/traces?limit=10")
			for _, original := range []string{promptRaw, errorRaw, userAgentRaw} {
				if !strings.Contains(listBody, original) {
					t.Fatalf("%s lost raw trace list field %q: %s", role, original, listBody)
				}
			}
		}
	}
}
