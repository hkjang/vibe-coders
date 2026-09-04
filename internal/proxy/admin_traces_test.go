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
		{name: "explain method", method: http.MethodPost, path: "/admin/requests/request-1/explain", handler: server.handleRequestExplain, want: http.StatusMethodNotAllowed},
		{name: "explain invalid id", method: http.MethodGet, path: "/admin/requests/a/b/explain", handler: server.handleRequestExplain, want: http.StatusBadRequest},
		{name: "links method", method: http.MethodPost, path: "/admin/requests/request-1/links", handler: server.handleRequestLinks, want: http.StatusMethodNotAllowed},
		{name: "links invalid id", method: http.MethodGet, path: "/admin/requests/a/b/links", handler: server.handleRequestLinks, want: http.StatusBadRequest},
		{name: "diff method", method: http.MethodPost, path: "/admin/requests/diff?a=left&b=right", handler: server.handleRequestDiff, want: http.StatusMethodNotAllowed},
		{name: "diff duplicate id", method: http.MethodGet, path: "/admin/requests/diff?a=left&a=other&b=right", handler: server.handleRequestDiff, want: http.StatusBadRequest},
		{name: "diff oversized id", method: http.MethodGet, path: "/admin/requests/diff?a=" + strings.Repeat("a", adminTracePathIDMaxBytes+1) + "&b=right", handler: server.handleRequestDiff, want: http.StatusBadRequest},
		{name: "request detail method", method: http.MethodPost, path: "/admin/requests/request-1", handler: server.handleRequestDetail, want: http.StatusMethodNotAllowed},
		{name: "note method", method: http.MethodPatch, path: "/admin/requests/missing/note", handler: server.handleRequestNote, want: http.StatusMethodNotAllowed},
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
		"/admin/requests/a%2Fb/explain",
		"/admin/requests/a%2Fb/links",
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
		method  string
		path    string
		code    string
		message string
	}{
		{name: "llm list", method: http.MethodGet, path: "/admin/llm/traces", code: "llm_traces_failed", message: "trace list query failed"},
		{name: "llm detail", method: http.MethodGet, path: "/admin/llm/traces/request-db-failure", code: "llm_trace_detail_failed", message: "trace detail query failed"},
		{name: "request list", method: http.MethodGet, path: "/admin/requests", code: "requests_failed", message: "request list query failed"},
		{name: "request detail", method: http.MethodGet, path: "/admin/requests/request-db-failure", code: "request_detail_failed", message: "request detail could not be loaded"},
		{name: "request headers", method: http.MethodGet, path: "/admin/requests/request-db-failure/headers", code: "request_detail_failed", message: "request detail could not be loaded"},
		{name: "request waterfall", method: http.MethodGet, path: "/admin/requests/request-db-failure/trace", code: "trace_failed", message: "request trace query failed"},
		{name: "request explain", method: http.MethodGet, path: "/admin/requests/request-db-failure/explain", code: "explain_failed", message: "request explanation could not be loaded"},
		{name: "request links", method: http.MethodGet, path: "/admin/requests/request-db-failure/links", code: "request_links_failed", message: "request links could not be loaded"},
		{name: "request note", method: http.MethodGet, path: "/admin/requests/request-db-failure/note", code: "request_lookup_failed", message: "request lookup failed"},
		{name: "request diff", method: http.MethodGet, path: "/admin/requests/diff?a=request-db-failure&b=other", code: "request_diff_failed", message: "request diff lookup failed"},
		{name: "request replay", method: http.MethodPost, path: "/admin/requests/request-db-failure/replay", code: "request_lookup_failed", message: "request lookup failed"},
		{name: "request analyze", method: http.MethodPost, path: "/admin/requests/request-db-failure/analyze", code: "request_detail_failed", message: "request detail could not be loaded"},
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

			request, err := http.NewRequestWithContext(t.Context(), test.method, gateway.URL+test.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.DefaultClient.Do(request)
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
	if err := db.UpsertCustomRole(t.Context(), store.CustomRole{
		Role: "trace_exporter", Scopes: []string{"admin:read", "admin:write"}, DefaultHome: "/admin",
	}); err != nil {
		t.Fatal(err)
	}
	exporterToken := createRole("trace_exporter")

	const (
		requestID         = "trace-sensitive-request"
		promptRaw         = "prompt belongs to prompt-sensitive@example.com"
		responseRaw       = "response belongs to response-sensitive@example.com"
		errorRaw          = "upstream failed for error-sensitive@example.com"
		fallbackRaw       = "fallback failed for fallback-sensitive@example.com"
		rejectRaw         = "SQL rejected for reject-sensitive@example.com"
		userAgentRaw      = "trace-client user-agent-sensitive@example.com"
		approvalRaw       = "approval for approval-sensitive@example.com"
		evaluationRaw     = "evaluation by evaluation-sensitive@example.com"
		toolRaw           = "tool owned by tool-sensitive@example.com"
		feedbackRaw       = "feedback from feedback-sensitive@example.com"
		feedbackSourceRaw = "source-sensitive@example.com"
		feedbackAuthorRaw = "creator-sensitive@example.com"
		noteRaw           = "note from note-sensitive@example.com"
		noteAuthorRaw     = "note-author-sensitive@example.com"
		tagRaw            = "tag-sensitive@example.com"
		finishRaw         = "finish-sensitive@example.com"
		languageRaw       = "language-sensitive@example.com"
		policyRaw         = "policy-sensitive@example.com"
		payloadRaw        = "payload-sensitive@example.com"
		mcpExposedRaw     = "mcp-sensitive@example.com"
		mcpPolicyRaw      = "policy-owner-sensitive@example.com"
		mcpReasonRaw      = "mcp-reason-sensitive@example.com"
		endpointRaw       = "/v1/https://endpoint-user:endpoint-pass@endpoint.invalid"
		credentialKeyRaw  = "https://map-user:map-pass@map.invalid"
		bodyKeyRaw        = "body-key-sensitive@example.com"
		clientIPRaw       = "client-ip-sensitive@example.com"
		forwardedForRaw   = "192.0.2.44, forwarded-sensitive@example.com"
		sessionRaw        = "session-sensitive@example.com"
		modelPIIRaw       = "model-sensitive@example.com"
		numericPIIRaw     = "4111111111111111"
		unsafeProviderRaw = "https://legacy-user:legacy-pass@provider.invalid"
	)
	createdAt := time.Date(2026, 9, 4, 3, 4, 5, 0, time.UTC)
	fixtureJSON := func(value any) string {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: "trace-sensitive", Method: http.MethodPost,
			Endpoint: endpointRaw, Model: modelPIIRaw + "-via-" + unsafeProviderRaw,
			Provider: unsafeProviderRaw, RouteDetail: "route-via-" + unsafeProviderRaw,
			StatusCode: http.StatusBadGateway, Error: errorRaw, Failover: true,
			FallbackFrom: unsafeProviderRaw, FallbackReason: fallbackRaw,
			ClientIP: clientIPRaw, ForwardedFor: forwardedForRaw, SessionID: sessionRaw,
			UserAgent: userAgentRaw, BodyRaw: fixtureJSON(map[string]any{
				"model":    "raw-via-" + unsafeProviderRaw,
				bodyKeyRaw: "value hidden behind a sensitive JSON key",
			}),
			HeaderSummaryJSON: fixtureJSON(map[string]any{
				"client": map[string]any{
					"X-Legacy-Provider": "header-via-" + unsafeProviderRaw,
					credentialKeyRaw:    "credential-shaped map key",
				},
			}),
			BodySummaryJSON: fixtureJSON(map[string]any{
				"parameters": map[string]any{"model": "body-via-" + unsafeProviderRaw, "user": 4111111111111111},
				"masked_raw": map[string]any{"model": "summary-via-" + unsafeProviderRaw},
			}),
			RoutingSummaryJSON: fixtureJSON(map[string]any{"decision_reason": "routing-via-" + unsafeProviderRaw}),
			PolicySummaryJSON:  fixtureJSON(map[string]any{"reason": "policy-via-" + unsafeProviderRaw}),
			PromptName:         "prompt-name-via-" + unsafeProviderRaw, PromptVersion: tagRaw,
			LatencyMS: 123, CreatedAt: createdAt,
		},
		Prompts: []store.PromptLog{{
			ID: "prompt-sensitive", RequestID: requestID, Role: "role-via-" + unsafeProviderRaw,
			ContentText: promptRaw, RedactedText: promptRaw, LanguageHint: languageRaw, CreatedAt: createdAt,
		}},
		Response: &store.ResponseLog{
			ID: "response-sensitive", RequestID: requestID, StatusCode: http.StatusBadGateway,
			ResponseTextOptional: responseRaw, FinishReason: finishRaw, CreatedAt: createdAt,
		},
		Routing: &store.RoutingDecisionLog{
			ID: "routing-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
			RequestedModel:   modelPIIRaw + "-routing-via-" + unsafeProviderRaw,
			SelectedModel:    modelPIIRaw + "-selected-via-" + unsafeProviderRaw,
			SelectedProvider: unsafeProviderRaw,
			FallbackPath:     []string{unsafeProviderRaw},
			DecisionReason:   "routing-decision-via-" + unsafeProviderRaw,
			CreatedAt:        createdAt,
		},
		Evaluations: []store.LLMEvaluation{{
			ID: "evaluation-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
			Name: "evaluation-via-" + unsafeProviderRaw, Category: "security",
			Evaluator: evaluationRaw, Label: "label-via-" + unsafeProviderRaw,
			Passed: false, Reason: evaluationRaw,
			Metadata: fixtureJSON(map[string]any{"provider": unsafeProviderRaw}), CreatedAt: createdAt,
		}},
		Tools: []store.ToolInvocation{{
			ID: "tool-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
			ServerLabel: unsafeProviderRaw, ToolName: toolRaw + " via " + unsafeProviderRaw,
			Source: "call", IsMCP: true, CreatedAt: createdAt,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRequestNote(t.Context(), store.RequestNote{
		RequestID: requestID, Tags: []string{tagRaw, "tag-via-" + unsafeProviderRaw},
		Note: noteRaw + " via " + unsafeProviderRaw, CreatedBy: noteAuthorRaw, UpdatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLLMFeedback(t.Context(), store.LLMFeedback{
		ID: "feedback-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
		Rating: -1, Label: feedbackRaw, Comment: feedbackRaw + " via " + unsafeProviderRaw,
		Source: feedbackSourceRaw, CreatedBy: feedbackAuthorRaw, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertPolicyDecisionEvent(t.Context(), store.PolicyDecisionEvent{
		ID: "policy-sensitive", RequestID: requestID, PolicyID: "policy-1", Decision: "allow",
		Model: modelPIIRaw + "-policy-via-" + unsafeProviderRaw, Provider: unsafeProviderRaw,
		Reason: policyRaw + " via " + unsafeProviderRaw, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertApproval(t.Context(), store.Approval{
		ID: "approval-sensitive", RequestID: requestID, SubjectType: "provider",
		SubjectID: unsafeProviderRaw, Status: "pending", Reason: approvalRaw + " via " + unsafeProviderRaw,
		Payload:   fixtureJSON(map[string]any{"provider": unsafeProviderRaw, "owner": payloadRaw}),
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour), CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertMCPRouteDecision(t.Context(), store.MCPRouteDecision{
		ID: "mcp-route-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
		Method: "tools/call", ExposedName: mcpExposedRaw + " via " + unsafeProviderRaw,
		UpstreamName: unsafeProviderRaw, TargetName: "target-via-" + unsafeProviderRaw,
		ServerPolicy: mcpPolicyRaw, FinalDecision: "allow",
		Reason:    mcpReasonRaw + " via " + unsafeProviderRaw,
		CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertText2SQLSpans(t.Context(), []store.Text2SQLSpan{{
		ID: "text2sql-sensitive", RequestID: requestID, TraceID: "trace-sensitive",
		Stage: "validate", Status: "error", Model: modelPIIRaw + "-text2sql-via-" + unsafeProviderRaw,
		RejectReason: rejectRaw, Detail: "text2sql-detail-via-" + unsafeProviderRaw, CreatedAt: createdAt,
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
	postBody := func(token, path string) string {
		t.Helper()
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, gateway.URL+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
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
			t.Fatalf("POST %s status=%d body=%s", path, response.StatusCode, body)
		}
		return string(body)
	}
	postStatus := func(token, path string) int {
		t.Helper()
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, gateway.URL+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}
	paths := []string{
		"/admin/llm/traces?limit=10",
		"/admin/llm/traces/" + requestID,
		"/admin/requests/" + requestID,
		"/admin/requests/" + requestID + "/trace",
		"/admin/requests/" + requestID + "/headers",
		"/admin/requests/" + requestID + "/routing",
		"/admin/requests/" + requestID + "/body",
		"/admin/requests/" + requestID + "/timeline",
		"/admin/requests/" + requestID + "/note",
		"/admin/requests/" + requestID + "/explain",
		"/admin/requests/" + requestID + "/links",
		"/admin/traces/trace-sensitive",
	}
	for _, path := range paths {
		body := getBody(readonlyToken, path)
		for _, sensitive := range []string{promptRaw, responseRaw, errorRaw, fallbackRaw, rejectRaw, userAgentRaw, approvalRaw, evaluationRaw, toolRaw, feedbackRaw, feedbackSourceRaw, feedbackAuthorRaw, noteRaw, noteAuthorRaw, tagRaw, finishRaw, languageRaw, policyRaw, payloadRaw, mcpExposedRaw, mcpPolicyRaw, mcpReasonRaw, endpointRaw, credentialKeyRaw, bodyKeyRaw, clientIPRaw, forwardedForRaw, sessionRaw, modelPIIRaw, numericPIIRaw, unsafeProviderRaw} {
			if strings.Contains(body, sensitive) {
				t.Fatalf("lower-privilege response %s exposed %q: %s", path, sensitive, body)
			}
		}
		if (strings.Contains(path, "/llm/traces") || strings.HasSuffix(path, "/trace") || strings.HasSuffix(path, requestID)) && !strings.Contains(body, "[REDACTED_EMAIL]") {
			t.Fatalf("lower-privilege response %s did not apply audit redaction: %s", path, body)
		}
		if !strings.Contains(body, providerNameOmitted) {
			t.Fatalf("lower-privilege response %s did not project the legacy provider: %s", path, body)
		}
	}
	readonlyExplain := getBody(readonlyToken, "/admin/requests/"+requestID+"/explain")
	if !strings.Contains(readonlyExplain, "[REDACTED_EMAIL]") {
		t.Fatalf("lower-privilege explain response did not audit-redact governance/evaluation metadata: %s", readonlyExplain)
	}
	for _, field := range []string{"model", "language", "tag"} {
		body := getBody(readonlyToken, "/admin/suggest?field="+field)
		for _, sensitive := range []string{tagRaw, languageRaw, modelPIIRaw, unsafeProviderRaw} {
			if strings.Contains(body, sensitive) {
				t.Fatalf("lower-privilege %s suggestions exposed %q: %s", field, sensitive, body)
			}
		}
	}
	exportBody := postBody(exporterToken, "/admin/requests/"+requestID+"/export")
	for _, sensitive := range []string{promptRaw, responseRaw, bodyKeyRaw, clientIPRaw, forwardedForRaw, sessionRaw, modelPIIRaw, numericPIIRaw, unsafeProviderRaw} {
		if strings.Contains(exportBody, sensitive) {
			t.Fatalf("lower-privilege export exposed %q: %s", sensitive, exportBody)
		}
	}
	if !strings.Contains(exportBody, providerNameOmitted) {
		t.Fatalf("lower-privilege export did not project the legacy provider: %s", exportBody)
	}
	for _, path := range []string{
		"/admin/requests/" + requestID + "/analyze",
		"/admin/requests/" + requestID + "/replay",
	} {
		if status := postStatus(exporterToken, path); status != http.StatusForbidden {
			t.Fatalf("lower-privilege raw operation %s status=%d, want %d", path, status, http.StatusForbidden)
		}
	}
	for role, token := range map[string]string{
		"super_admin": rootToken,
		"admin":       adminToken,
		"security":    securityToken,
	} {
		tagSuggestions := getBody(token, "/admin/suggest?field=tag")
		if !strings.Contains(tagSuggestions, tagRaw) {
			t.Fatalf("%s lost raw privileged tag suggestion %q: %s", role, tagRaw, tagSuggestions)
		}
		llmBody := getBody(token, "/admin/llm/traces/"+requestID)
		for _, original := range []string{promptRaw, responseRaw, errorRaw, fallbackRaw, rejectRaw, userAgentRaw, approvalRaw, evaluationRaw, toolRaw, feedbackRaw, feedbackSourceRaw, feedbackAuthorRaw, finishRaw, languageRaw, policyRaw, payloadRaw, endpointRaw, credentialKeyRaw, clientIPRaw, forwardedForRaw, sessionRaw, modelPIIRaw, numericPIIRaw, unsafeProviderRaw} {
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
		traceBody := getBody(token, "/admin/traces/trace-sensitive")
		if !strings.Contains(traceBody, unsafeProviderRaw) {
			t.Fatalf("%s lost raw trace-wide provider %q: %s", role, unsafeProviderRaw, traceBody)
		}
		for _, path := range []string{
			"/admin/requests/" + requestID,
			"/admin/requests/" + requestID + "/headers",
			"/admin/requests/" + requestID + "/routing",
			"/admin/requests/" + requestID + "/body",
			"/admin/requests/" + requestID + "/timeline",
			"/admin/requests/" + requestID + "/note",
			"/admin/requests/" + requestID + "/explain",
			"/admin/requests/" + requestID + "/links",
		} {
			body := getBody(token, path)
			if !strings.Contains(body, unsafeProviderRaw) {
				t.Fatalf("%s lost raw provider in %s: %s", role, path, body)
			}
		}
		noteBody := getBody(token, "/admin/requests/"+requestID+"/note")
		for _, original := range []string{noteRaw, noteAuthorRaw, tagRaw, unsafeProviderRaw} {
			if !strings.Contains(noteBody, original) {
				t.Fatalf("%s lost raw request note metadata %q: %s", role, original, noteBody)
			}
		}
		linksBody := getBody(token, "/admin/requests/"+requestID+"/links")
		for _, original := range []string{mcpExposedRaw, mcpPolicyRaw, mcpReasonRaw} {
			if !strings.Contains(linksBody, original) {
				t.Fatalf("%s lost raw MCP routing metadata %q: %s", role, original, linksBody)
			}
		}
	}
}

func TestLegacyReadonlyAdminTokenCannotViewRawTraceContent(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		logger.Stop(context.Background())
		db.Close()
	})

	cfg := testConfig("http://example.invalid", "upstream-secret")
	cfg.Auth.Enabled = false
	cfg.Auth.AdminToken = "legacy-write-token"
	cfg.Auth.AdminReadonlyToken = "legacy-read-token"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	const (
		requestID  = "legacy-token-sensitive-request"
		provider   = "https://legacy-user:legacy-pass@provider.invalid"
		promptText = "legacy prompt for legacy-reader@example.com"
	)
	createdAt := time.Date(2026, 9, 4, 4, 5, 6, 0, time.UTC)
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: "legacy-token-sensitive-trace", Method: http.MethodPost,
			Endpoint: "/v1/chat/completions", Model: "model-via-" + provider,
			Provider: provider, FallbackFrom: provider, RouteDetail: "route-via-" + provider,
			BodyRaw:            `{"model":"raw-via-` + provider + `"}`,
			BodySummaryJSON:    `{"parameters":{"model":"body-via-` + provider + `"}}`,
			RoutingSummaryJSON: `{"decision_reason":"routing-via-` + provider + `"}`,
			StatusCode:         http.StatusOK, CreatedAt: createdAt,
		},
		Prompts: []store.PromptLog{{
			ID: "legacy-token-prompt", RequestID: requestID, Role: "user",
			ContentText: promptText, RedactedText: promptText, CreatedAt: createdAt,
		}},
	}); err != nil {
		t.Fatal(err)
	}

	getBody := func(token, path string) string {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, response.StatusCode, body)
		}
		return string(body)
	}

	for _, path := range []string{
		"/admin/llm/traces?limit=10",
		"/admin/llm/traces/" + requestID,
		"/admin/requests/" + requestID,
		"/admin/requests/" + requestID + "/body",
	} {
		body := getBody("legacy-read-token", path)
		if strings.Contains(body, promptText) || strings.Contains(body, provider) {
			t.Fatalf("legacy readonly response %s exposed raw content: %s", path, body)
		}
		if !strings.Contains(body, providerNameOmitted) {
			t.Fatalf("legacy readonly response %s did not project provider: %s", path, body)
		}
	}

	adminDetail := getBody("legacy-write-token", "/admin/llm/traces/"+requestID)
	if !strings.Contains(adminDetail, promptText) || !strings.Contains(adminDetail, provider) {
		t.Fatalf("legacy full admin lost raw trace content: %s", adminDetail)
	}
	adminBody := getBody("legacy-write-token", "/admin/requests/"+requestID+"/body")
	if !strings.Contains(adminBody, provider) {
		t.Fatalf("legacy full admin lost raw body provider: %s", adminBody)
	}
}
