package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestLLMObservabilityTeamScopeProjectionAndAdminCompatibility(t *testing.T) {
	db := openTestStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Add(-time.Minute)
	for _, team := range []store.AuthTeam{
		{ID: "llm-team-alpha-id", Name: "llm-team-alpha-name"},
		{ID: "llm-team-beta-id", Name: "llm-team-beta-name"},
	} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []store.APIKeyRecord{
		{ID: "llm-team-alpha-key", Name: "alpha", KeyHash: "alpha-hash", Team: "llm-team-alpha-name", Status: "active"},
		{ID: "llm-team-beta-key", Name: "beta", KeyHash: "beta-hash", Team: "llm-team-beta-name", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}

	const credential = "vc_sk_abcdefghijklmnopqrstuvwxyzABCDEF"
	insertProxyLLMScopedRequest(t, db, "llm-alpha-request", "llm-team-alpha-key", "llm-shared-session", "alpha-prompt", credential, now)
	insertProxyLLMScopedRequest(t, db, "llm-beta-request", "llm-team-beta-key", "llm-shared-session", "beta-prompt", "beta-version", now.Add(time.Second))
	insertProxyLLMScopedRequest(t, db, "llm-beta-only-request", "llm-team-beta-key", "llm-beta-only-session", "beta-only-prompt", "beta-only-version", now.Add(2*time.Second))

	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "llm-team-scope.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "llm-team-scope-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	cfg.Auth.ServiceKeyPrefix = "vc_sa_"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	teamToken := issueLLMScopedTestToken(t, db, server, "llm-team-admin", "team_admin", "llm-team-alpha-id", []string{"admin:read"}, now)
	emptyTeamToken := issueLLMScopedTestToken(t, db, server, "llm-empty-team-admin", "team_admin", "", []string{"admin:read"}, now)
	adminToken := issueLLMScopedTestToken(t, db, server, "llm-super-admin", "super_admin", "", []string{"admin:read", "admin:write"}, now)
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	get := func(token, path string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}

	status, body := get(teamToken, "/admin/llm/sessions")
	var sessions struct {
		Sessions []store.LLMSessionSummary `json:"sessions"`
	}
	if err := json.Unmarshal(body, &sessions); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || len(sessions.Sessions) != 1 || sessions.Sessions[0].Requests != 1 {
		t.Fatalf("team-scoped LLM sessions = status %d payload %+v body=%s", status, sessions, body)
	}
	assertLLMExternalBody(t, body, credential, "llm-beta-request", "beta-prompt", "beta-only-prompt")

	status, body = get(teamToken, "/admin/llm/session?session_id=llm-shared-session")
	var timeline store.SessionTimeline
	if err := json.Unmarshal(body, &timeline); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || timeline.Requests != 1 || len(timeline.Points) != 1 || timeline.Points[0].RequestID != "llm-alpha-request" {
		t.Fatalf("team-scoped LLM timeline = status %d payload %+v body=%s", status, timeline, body)
	}
	assertLLMExternalBody(t, body, credential, "llm-beta-request", "beta-prompt")

	if status, body = get(teamToken, "/admin/llm/session?session_id=llm-beta-only-session"); status != http.StatusForbidden {
		t.Fatalf("cross-team LLM session status=%d body=%s", status, body)
	}
	if status, body = get(teamToken, "/admin/llm/traces?team=llm-team-beta-name"); status != http.StatusOK || strings.Contains(string(body), "llm-alpha-request") || strings.Contains(string(body), "llm-beta-request") {
		t.Fatalf("explicit cross-team trace filter was not intersected: status=%d body=%s", status, body)
	}

	teamPaths := []string{
		"/admin/llm/traces?limit=20",
		"/admin/llm/prompts?limit=20",
		"/admin/llm/prompts/compare?prompt_name=alpha-prompt&candidate=" + url.QueryEscape(credential),
		"/admin/llm/patterns?limit=20",
		"/admin/llm/insights?window=24h&limit=20",
		"/admin/llm/timeseries?window=24h&bucket=hour",
		"/admin/llm/feedback?limit=20",
		"/admin/llm/evaluations?limit=20",
	}
	for _, path := range teamPaths {
		status, body = get(teamToken, path)
		if status != http.StatusOK {
			t.Fatalf("team-scoped %s status=%d body=%s", path, status, body)
		}
		assertLLMExternalBody(t, body, credential, "llm-beta-request", "llm-beta-only-request", "beta-prompt", "beta-only-prompt")
	}

	status, body = get(teamToken, "/admin/llm/timeseries?window=24h&bucket=hour")
	var timeseries struct {
		Points []store.LLMTimeseriesPoint `json:"points"`
	}
	if err := json.Unmarshal(body, &timeseries); err != nil {
		t.Fatal(err)
	}
	var scopedRequests int64
	for _, point := range timeseries.Points {
		scopedRequests += point.Requests
	}
	if scopedRequests != 1 {
		t.Fatalf("team-scoped LLM timeseries requests=%d, want 1: %s", scopedRequests, body)
	}

	for _, path := range []string{
		"/admin/llm/traces", "/admin/llm/sessions", "/admin/llm/prompts", "/admin/llm/patterns",
		"/admin/llm/insights?window=24h", "/admin/llm/timeseries?window=24h", "/admin/llm/feedback", "/admin/llm/evaluations",
	} {
		status, body = get(emptyTeamToken, path)
		if status != http.StatusOK {
			t.Fatalf("empty-team fail-closed %s status=%d body=%s", path, status, body)
		}
		if strings.Contains(string(body), "llm-alpha-request") || strings.Contains(string(body), "llm-beta-request") || strings.Contains(string(body), "alpha-prompt") || strings.Contains(string(body), "beta-prompt") {
			t.Fatalf("empty-team LLM endpoint leaked rows for %s: %s", path, body)
		}
	}
	if status, body = get(emptyTeamToken, "/admin/llm/session?session_id=llm-shared-session"); status != http.StatusForbidden {
		t.Fatalf("empty-team session lookup status=%d body=%s", status, body)
	}

	status, body = get(adminToken, "/admin/llm/session?session_id=llm-shared-session")
	if status != http.StatusOK || !strings.Contains(string(body), "llm-alpha-request") || !strings.Contains(string(body), "llm-beta-request") || !strings.Contains(string(body), credential) {
		t.Fatalf("privileged LLM timeline lost unrestricted raw compatibility: status=%d body=%s", status, body)
	}

	for _, path := range []string{"/admin/llm/sessions", "/admin/llm/session", "/admin/llm/prompts", "/admin/llm/prompts/compare", "/admin/llm/patterns", "/admin/llm/insights", "/admin/llm/timeseries"} {
		request, err := http.NewRequest(http.MethodPost, gateway.URL+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+adminToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != http.MethodGet {
			t.Fatalf("%s method contract: status=%d Allow=%q", path, response.StatusCode, response.Header.Get("Allow"))
		}
	}
}

func insertProxyLLMScopedRequest(t *testing.T, db *store.SQLStore, requestID, apiKeyID, sessionID, promptName, promptVersion string, createdAt time.Time) {
	t.Helper()
	record := store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: requestID + "-trace", APIKeyID: apiKeyID,
			Endpoint: "/v1/chat/completions", Model: requestID + "-model", Provider: requestID + "-provider",
			StatusCode: http.StatusInternalServerError, LatencyMS: 120, FirstChunkMS: 30,
			SessionID: sessionID, PromptName: promptName, PromptVersion: promptVersion, CreatedAt: createdAt,
		},
		Prompts: []store.PromptLog{{
			ID: requestID + "-prompt", RequestID: requestID, Role: "user",
			ContentText: promptName + " raw " + promptVersion, RedactedText: promptName + " safe " + promptVersion,
			LanguageHint: "ko", CreatedAt: createdAt,
		}},
		Usage: &store.TokenUsage{
			ID: requestID + "-usage", RequestID: requestID, TotalTokens: 10,
			EstimatedCost: 1, Currency: "KRW", Source: "usage", CreatedAt: createdAt,
		},
		Evaluations: []store.LLMEvaluation{{
			ID: requestID + "-evaluation", RequestID: requestID, TraceID: requestID + "-trace",
			Name: requestID + "-quality", Category: requestID + "-category", Evaluator: requestID + "-evaluator",
			Score: 0.1, Label: requestID + "-label", Passed: false,
			Reason: requestID + " reason " + promptVersion, Metadata: `{"detail":"` + promptVersion + `"}`, CreatedAt: createdAt,
		}},
	}
	if err := db.InsertLogRecord(t.Context(), record); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLLMFeedback(t.Context(), store.LLMFeedback{
		ID: requestID + "-feedback", RequestID: requestID, TraceID: requestID + "-trace",
		Rating: -1, Label: requestID + "-feedback-label", Comment: requestID + " comment " + promptVersion,
		Source: requestID + "-source", CreatedBy: requestID + "-author", CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func issueLLMScopedTestToken(t *testing.T, db *store.SQLStore, server *Server, subject, role, teamID string, scopes []string, now time.Time) string {
	t.Helper()
	sessionID := subject + "-session"
	if err := db.InsertAuthSession(t.Context(), sessionID, subject, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	token, err := server.signAccessToken(accessClaims{
		Subject: subject, Role: role, TeamID: teamID, Scopes: scopes, SessionID: sessionID,
		Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func assertLLMExternalBody(t *testing.T, body []byte, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if value != "" && strings.Contains(string(body), value) {
			t.Fatalf("external LLM response exposed %q: %s", value, body)
		}
	}
}
