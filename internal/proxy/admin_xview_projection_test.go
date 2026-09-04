package proxy

import (
	"context"
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

func TestXViewLowerRoleProjectionCoversSnapshotAggregatesAndLiveUpdates(t *testing.T) {
	db := openTestStore(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()

	const (
		teamID    = "xview-projection-team"
		apiKeyID  = "xview-projection-key"
		requestID = "xview-projection-request"
	)
	credential := "corp_" + strings.Repeat("A", 43)
	email := "xview-owner@example.com"
	card := "4111111111111111"

	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: teamID, Name: "XView projection team"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: apiKeyID, Name: "XView projection key", KeyHash: "xview-projection-hash", Team: teamID, Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertLogRecord(ctx, store.LogRecord{
		Request: store.RequestLog{
			ID: requestID, TraceID: "trace-for-" + email, APIKeyID: apiKeyID,
			Endpoint: "/v1/" + credential, Model: "model-via-" + credential, Provider: credential,
			StatusCode: http.StatusInternalServerError, LatencyMS: 250, FirstChunkMS: 100, CreatedAt: now,
		},
		Routing: &store.RoutingDecisionLog{
			ID: "routing-xview-projection", RequestID: requestID, TraceID: "trace-for-" + email,
			RequestedModel: "requested-via-" + credential, SelectedModel: "model-via-" + credential,
			SelectedProvider: credential, DecisionReason: "routing for " + card,
			CreatedAt: now,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertPolicyDecisionEvent(ctx, store.PolicyDecisionEvent{
		ID: "policy-xview-projection", RequestID: requestID, Decision: "policy-via-" + credential,
		Reason: "policy for " + email, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertApproval(ctx, store.Approval{
		ID: "approval-xview-projection", RequestID: requestID, Status: "approval-via-" + credential,
		Reason: "approval for " + email, ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertSecretEvent(ctx, store.SecretEvent{
		ID: "secret-xview-projection", RequestID: requestID, SecretType: "api_key",
		Action: "secret-via-" + credential, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "xview-projection.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "xview-projection-jwt-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	cfg.Auth.APIKeyPrefix = "corp_"
	cfg.Auth.ServiceKeyPrefix = "service_"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	issueToken := func(subject, role string) string {
		t.Helper()
		sessionID := subject + "-session"
		if err := db.InsertAuthSession(ctx, sessionID, subject, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		token, err := server.signAccessToken(accessClaims{
			Subject: subject, Role: role, TeamID: teamID, Scopes: []string{"admin:read"},
			SessionID: sessionID, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	lowerToken := issueToken("xview-projection-team-admin", "team_admin")
	privilegedToken := issueToken("xview-projection-admin", "admin")
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	getBody := func(token, path string) string {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, resp.StatusCode, body)
		}
		return string(body)
	}

	paths := []struct {
		path             string
		lowerValues      []string
		privilegedValues []string
	}{
		{"/admin/scatter?window=1h&include_summary=true", []string{requestID, providerNameOmitted, providerMetadataOmitted, "[REDACTED_EMAIL]", "[REDACTED_CARD]"}, []string{credential, email, card}},
		{"/admin/xview/delta?window=1h&refresh=true", []string{requestID, providerNameOmitted, providerMetadataOmitted, "[REDACTED_EMAIL]", "[REDACTED_CARD]"}, []string{credential, email, card}},
		{"/admin/xview/delta?window=1h&reconcile=true", []string{requestID, providerNameOmitted, providerMetadataOmitted, "[REDACTED_EMAIL]", "[REDACTED_CARD]"}, []string{credential, email, card}},
		{"/admin/xview/models?window=1h&top=10", []string{providerMetadataOmitted}, []string{credential}},
		{"/admin/xview/model-series?window=1h&bucket=hour", []string{providerMetadataOmitted}, []string{credential}},
		{"/admin/xview/model-outliers?window=1h", []string{requestID, providerMetadataOmitted, "[REDACTED_EMAIL]"}, []string{credential, email}},
	}
	for _, testCase := range paths {
		lowerBody := getBody(lowerToken, testCase.path)
		for _, expected := range testCase.lowerValues {
			if !strings.Contains(lowerBody, expected) {
				t.Errorf("lower-role XView response %s lost safe/projected row marker %q: %s", testCase.path, expected, lowerBody)
			}
		}
		for _, forbidden := range []string{credential, email, card} {
			if strings.Contains(lowerBody, forbidden) {
				t.Errorf("lower-role XView response %s exposed %q: %s", testCase.path, forbidden, lowerBody)
			}
		}
		privilegedBody := getBody(privilegedToken, testCase.path)
		for _, expected := range testCase.privilegedValues {
			if !strings.Contains(privilegedBody, expected) {
				t.Errorf("privileged XView response %s lost %q: %s", testCase.path, expected, privilegedBody)
			}
		}
	}

	// With no row beyond this future cursor, the store echoes the caller-provided
	// after_request_id. The lower-role response must project it, while privileged
	// callers retain the existing cursor contract.
	cursorQuery := url.Values{
		"window":            {"1h"},
		"after_ingested_at": {now.Add(time.Hour).Format(time.RFC3339Nano)},
		"after_request_id":  {credential},
	}
	cursorPath := "/admin/xview/delta?" + cursorQuery.Encode()
	if body := getBody(lowerToken, cursorPath); strings.Contains(body, credential) {
		t.Fatalf("lower-role delta cursor reflected configured credential: %s", body)
	}
	if body := getBody(privilegedToken, cursorPath); !strings.Contains(body, credential) {
		t.Fatalf("privileged delta cursor representation changed: %s", body)
	}
}
