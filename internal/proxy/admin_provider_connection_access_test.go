package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestProviderConnectionTestStrictInputNeverExecutes(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	t.Cleanup(upstream.Close)
	server, db, gateway := newConnectionTestServer(t)
	server.cfg.Auth.APIKeyPrefix = "corp_"
	valid := `"name":"new","base_url":"` + upstream.URL + `","credential_mode":"none"`
	for _, body := range []string{
		`null`, `[]`, `{}`, `{` + valid + `} {}`, `{` + valid + `,"unknown":"secret"}`,
		`{` + valid + `,"name":"other"}`, `{` + valid + `,"Name":"other"}`,
		`{` + valid + `,"api_key":null}`, `{` + valid + `,"api_key":""}`,
		`{` + valid + `,"provider_ref":"prv_` + strings.Repeat("a", 43) + `"}`,
		`{` + valid + `,"timeout_ms":-1}`, `{` + valid + `,"timeout_ms":600001}`,
		`{` + valid + `,"timeout_ms":null}`, `{` + valid + `,"timeout_ms":"20"}`, `{` + valid + `,"timeout_ms":2.5}`,
		`{"name":null,"base_url":"` + upstream.URL + `","credential_mode":"none"}`,
		`{"name":"","base_url":"` + upstream.URL + `","credential_mode":"none"}`,
		`{"provider_ref":"existing-name","base_url":"` + upstream.URL + `","credential_mode":"stored"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"stored"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"draft"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"draft","api_key":" "}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"draft","api_key":"line\r\ninjection"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"draft","api_key":"` + strings.Repeat("x", 8193) + `"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"automatic"}`,
		`{"name":"new","base_url":"` + upstream.URL + `","credential_mode":"none","extra":"` + strings.Repeat("x", 32769) + `"}`,
	} {
		status, _, raw := connectionPostRaw(t, gateway.URL, "", body)
		if status != 400 || strings.Contains(raw, "injection") || calls.Load() != 0 {
			t.Fatalf("invalid input was accepted or reflected: status=%d calls=%d", status, calls.Load())
		}
	}
	for _, target := range []string{
		upstream.URL + "?api_key=private-value", upstream.URL + "/corp_" + strings.Repeat("a", 32),
		upstream.URL + "/%63%6f%72%70_" + strings.Repeat("b", 32),
		"http://user:private-pass@127.0.0.1", "file:///tmp/not-provider", invalidProviderURLDisplay,
		upstream.URL + "/" + strings.Repeat("a", 8192),
	} {
		status, _, raw := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": target, "credential_mode": "none"})
		if status != 400 || !strings.Contains(raw, "invalid_base_url") || strings.Contains(raw, "private-") || calls.Load() != 0 {
			t.Fatalf("unsafe destination allowed or reflected: status=%d", status)
		}
	}
	for _, name := range []string{"sk-ant-very-private-name", "corp_" + strings.Repeat("a", 32), strings.Repeat("a", maxModelsProviderNameBytes+1)} {
		status, _, raw := connectionPost(t, gateway.URL, "", map[string]any{"name": name, "base_url": upstream.URL, "credential_mode": "none"})
		if status != 400 || !strings.Contains(raw, "invalid_provider_name") || calls.Load() != 0 {
			t.Fatal("unsafe new provider name allowed")
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("unaccepted credential payloads created probe audits")
	}
}

func TestProviderConnectionTestLatestFeatureSettingsAndMethod(t *testing.T) {
	for _, tc := range []struct {
		key, value string
		status     int
	}{
		{appUIEnabledKey, "false", 403},
		{appUIEnabledKey, "broken", 503},
		{"ui.app.feature.gateway.providers.status", "hidden", 403},
		{"ui.app.feature.gateway.providers.status", "legacy", 403},
		{"ui.app.feature.gateway.providers.status", "preview_read_only", 403},
		{"ui.app.feature.gateway.providers.status", "unknown", 503},
		{"ui.app.feature.gateway.providers.readonly", "true", 403},
		{"ui.app.feature.gateway.providers.readonly", "broken", 503},
		{"ui.app.feature.gateway.providers.roles", "readonly_admin", 403},
		{"ui.app.feature.gateway.providers.roles", "invalid_role", 403},
		{"ui.app.feature.gateway.providers.roles", "INVALID ROLE", 503},
		{"ui.app.feature.gateway.providers.rollout", "0", 403},
		{"ui.app.feature.gateway.providers.rollout", "101", 503},
		{"ui.app.feature.gateway.providers.rollout", "broken", 503},
		{"ui.app.feature.gateway.providers.status", "preview", 200},
		{"ui.app.feature.gateway.providers.status", "stable", 200},
		{"ui.app.feature.gateway.providers.status", "deprecated", 200},
		{"ui.app.feature.gateway.providers.status", "retired", 200},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, `{"data":[]}`)
			}))
			t.Cleanup(upstream.Close)
			server, _, gateway := newConnectionTestServer(t)
			setAppUITelemetryTestSetting(t, server, tc.key, tc.value)
			// No runtime reload, and no X-Vibe-UI header: the shared DB is authoritative.
			status, _, _ := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
			if status != tc.status || status != 200 && calls.Load() != 0 {
				t.Fatalf("current setting ignored: status=%d calls=%d", status, calls.Load())
			}
		})
	}
	server, _, _ := newConnectionTestServer(t)
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, connectionTestPath, nil)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, req)
		if response.Code != 405 || response.Header().Get("Allow") != "POST" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("unsupported method not safely rejected")
		}
	}
	req := httptest.NewRequest(http.MethodPost, connectionTestPath+"?private=query", strings.NewReader(`{"name":"new","base_url":"http://unused.invalid","credential_mode":"none"}`))
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, req)
	if response.Code != 400 {
		t.Fatal("query parameters should not be accepted")
	}
}

func TestProviderConnectionTestExistingAuthenticationAndScopes(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "probe.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret = true, "probe-test-jwt"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	setAppUITelemetryTestSetting(t, server, appUIEnabledKey, "true")
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	t.Cleanup(upstream.Close)
	for _, tc := range []struct {
		role   string
		scopes []string
		status int
	}{
		{"viewer", []string{"admin:read"}, 401},
		{"team_admin", []string{"admin:read"}, 401},
		{"ai_admin", []string{"admin:read"}, 401},
		{"admin", []string{"admin:write"}, 403},
		{"admin", []string{"admin:read", "admin:write"}, 200},
	} {
		t.Run(tc.role+strings.Join(tc.scopes, ","), func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, server, tc.role+strings.Join(tc.scopes, "-"), tc.role, "team", tc.scopes, time.Now().UTC())
			before := calls.Load()
			status, _, _ := connectionPost(t, gateway.URL, token, map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
			if status != tc.status || status != 200 && calls.Load() != before {
				t.Fatalf("wrong authentication/scope result: status=%d", status)
			}
		})
	}
	if status, _, _ := connectionPost(t, gateway.URL, "", map[string]any{}); status != 401 {
		t.Fatal("unauthenticated probe allowed")
	}
}

func TestProviderConnectionTestExpiredAuthorityLookupDoesNotTriggerAuthRefresh(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "authority.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret = true, "probe-authority-test-jwt"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	setAppUITelemetryTestSetting(t, server, appUIEnabledKey, "true")
	token := issueLLMScopedTestToken(t, db, server, "probe-authority", "admin", "team", []string{"admin:read", "admin:write"}, time.Now().UTC())
	request := func(ctx context.Context, credential string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, connectionTestPath, nil).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer "+credential)
		return r
	}
	if !server.providerConnectionAllowed(httptest.NewRecorder(), request(t.Context(), token)) {
		t.Fatal("valid JWT/active session control did not pass current authority checks")
	}
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "deadline"}[expired], func(t *testing.T) {
			var ctx context.Context
			var cancel context.CancelFunc
			if expired {
				ctx, cancel = context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
			} else {
				ctx, cancel = context.WithCancel(t.Context())
				cancel()
			}
			defer cancel()
			response := httptest.NewRecorder()
			if server.providerConnectionAllowed(response, request(ctx, token)) || response.Code != 503 || !strings.Contains(response.Body.String(), "provider_connection_unavailable") {
				t.Fatalf("unavailable authority lookup was misclassified as invalid credentials: status=%d", response.Code)
			}
		})
	}
	response := httptest.NewRecorder()
	if server.providerConnectionAllowed(response, request(t.Context(), "invalid-jwt")) || response.Code != 401 {
		t.Fatal("genuine invalid credentials must remain an authentication failure")
	}
}
