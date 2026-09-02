package proxy

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAgentRouteProviderValidationAndAppProjection(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	unsafeProvider := "sk-ant-legacy-agent-route-secret"
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: unsafeProvider, BaseURL: "https://example.invalid", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	route := store.AgentRoute{
		ID: "agr_legacy", VirtualModel: "vibe/agent-legacy", Name: "legacy", Enabled: true,
		BackingModel: "gpt-4o", Provider: unsafeProvider, MaxSteps: 2,
	}
	if err := db.UpsertAgentRoute(t.Context(), route); err != nil {
		t.Fatal(err)
	}

	legacy, err := http.Get(gateway.URL + "/admin/agent-routes/" + route.ID)
	if err != nil {
		t.Fatal(err)
	}
	legacyBody, _ := io.ReadAll(legacy.Body)
	legacy.Body.Close()
	if legacy.StatusCode != http.StatusOK || !strings.Contains(string(legacyBody), unsafeProvider) || strings.Contains(string(legacyBody), "provider_ref") {
		t.Fatalf("legacy route edit contract changed: status=%d body=%s", legacy.StatusCode, legacyBody)
	}

	app := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/agent-routes/"+route.ID, nil)
	appBody, _ := io.ReadAll(app.Body)
	app.Body.Close()
	if app.StatusCode != http.StatusOK || strings.Contains(string(appBody), unsafeProvider) ||
		!strings.Contains(string(appBody), boundedModelsProviderLabel(unsafeProvider)) ||
		!strings.Contains(string(appBody), server.providerRef(unsafeProvider)) {
		t.Fatalf("app route projection leaked/lost identity: status=%d body=%s", app.StatusCode, appBody)
	}
	appList := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/agent-routes", nil)
	appListBody, _ := io.ReadAll(appList.Body)
	appList.Body.Close()
	if appList.StatusCode != http.StatusOK || strings.Contains(string(appListBody), unsafeProvider) || !strings.Contains(string(appListBody), server.providerRef(unsafeProvider)) {
		t.Fatalf("app route list projection leaked/lost identity: status=%d body=%s", appList.StatusCode, appListBody)
	}

	route.ProviderRef = "prv_forged_client_value"
	updated := providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/agent-routes", route)
	updatedBody, _ := io.ReadAll(updated.Body)
	updated.Body.Close()
	if updated.StatusCode != http.StatusCreated || strings.Contains(string(updatedBody), unsafeProvider) || !strings.Contains(string(updatedBody), server.providerRef(unsafeProvider)) || strings.Contains(string(updatedBody), "forged_client_value") {
		t.Fatalf("exact legacy route update was not safely projected: status=%d body=%s", updated.StatusCode, updatedBody)
	}

	for _, tc := range []struct {
		name, provider, code string
	}{
		{name: "new unsafe", provider: "sk-ant-new-agent-route-secret", code: "agent_route_provider_invalid"},
		{name: "unknown", provider: "not-configured", code: "agent_route_provider_not_found"},
		{name: "reserved", provider: "vibe", code: "agent_route_provider_reserved"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := route
			candidate.ID = ""
			candidate.VirtualModel = "vibe/agent-" + strings.ReplaceAll(tc.name, " ", "-")
			candidate.Provider = tc.provider
			response := providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/agent-routes", candidate)
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), tc.code) || strings.Contains(string(body), tc.provider) {
				t.Fatalf("status=%d body=%s", response.StatusCode, body)
			}
		})
	}

	tested := providerAppRequest(t, http.MethodPost, gateway.URL+"/admin/agent-routes/"+route.ID+"/test", map[string]any{"prompt": "hello"})
	testedBody, _ := io.ReadAll(tested.Body)
	tested.Body.Close()
	if strings.Contains(string(testedBody), unsafeProvider) || !strings.Contains(string(testedBody), server.providerRef(unsafeProvider)) {
		t.Fatalf("admin route test leaked/lost provider identity: %s", testedBody)
	}

	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range audits {
		if strings.Contains(entry.BeforeValue+entry.AfterValue, unsafeProvider) {
			t.Fatalf("agent route audit leaked provider: %+v", entry)
		}
	}
}

func TestLegacyUnsafeProviderMetadataIsBoundedOnSuccess(t *testing.T) {
	unsafeProvider := "sk-ant-legacy-data-plane-secret"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Failover-From", unsafeProvider)
		w.Header().Set("X-Failover-Path", "5xx:"+unsafeProvider)
		w.Header().Set("X-Route-Detail", unsafeProvider)
		_, _ = io.WriteString(w, `{"id":"ok","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer upstream.Close()

	server, db, gateway := newProviderBoundaryServer(t, unsafeProvider)
	defer gateway.Close()
	key, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: unsafeProvider, BaseURL: upstream.URL, EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agr_boundary", VirtualModel: "vibe/agent-boundary", Name: "boundary", Enabled: true,
		BackingModel: "gpt-4o", Provider: unsafeProvider,
	}); err != nil {
		t.Fatal(err)
	}

	response, err := http.Post(gateway.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"vibe/agent-boundary","messages":[{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"noop","parameters":{"type":"object"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	reflected := response.Header.Get("X-Provider") + response.Header.Get("X-Agent-Provider") + response.Header.Get("X-Failover-From") + response.Header.Get("X-Failover-Path") + response.Header.Get("X-Route-Detail") + string(body)
	if response.StatusCode != http.StatusOK || strings.Contains(reflected, unsafeProvider) || response.Header.Get("X-Provider") != boundedModelsProviderLabel(unsafeProvider) {
		t.Fatalf("unsafe provider crossed success boundary: status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
	}
	if response.Header.Get("X-Agent-Provider") != boundedModelsProviderLabel(unsafeProvider) {
		t.Fatalf("unsafe agent provider header = %q", response.Header.Get("X-Agent-Provider"))
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(t.Context(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent requests: %#v err=%v", recent, err)
	}
	decisions, err := db.ListRoutingDecisions(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if recent[0].Provider != unsafeProvider {
		t.Fatalf("internal provider identity was lost: request=%+v", recent[0])
	}
	for _, decision := range decisions {
		if decision.DecisionReason == unsafeProvider || strings.Contains(strings.Join(decision.FallbackPath, ","), unsafeProvider) {
			t.Fatalf("provider leaked into descriptive routing metadata: %+v", decision)
		}
	}
}

func TestLegacyUnsafeProviderTransportFailureIsStableAndSanitized(t *testing.T) {
	unsafeProvider := "sk-ant-legacy-failure-provider-secret"
	urlSecret := "URL-QUERY-CREDENTIAL-SECRET"
	mattermostPayload := make(chan string, 1)
	mattermost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mattermostPayload <- string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer mattermost.Close()
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	server, db, gateway := newProviderBoundaryServer(t, unsafeProvider)
	defer gateway.Close()
	key, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: unsafeProvider, BaseURL: "http://127.0.0.1:1/v1?api_key=" + urlSecret,
		EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*", TimeoutMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"mattermost_enabled": "true", "mattermost_webhook_url": mattermost.URL, "mattermost_events": "provider",
	} {
		if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: key, Value: value}); err != nil {
			t.Fatal(err)
		}
	}
	server.invalidateMattermostCache()

	response, err := http.Post(gateway.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	visible := string(body) + response.Header.Get("X-Provider") + response.Header.Get("X-Failover-Path") + logs.String()
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "upstream request failed") ||
		strings.Contains(visible, unsafeProvider) || strings.Contains(visible, urlSecret) || strings.Contains(visible, "api_key") {
		t.Fatalf("transport error was not stable/sanitized: status=%d visible=%q", response.StatusCode, visible)
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(t.Context(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent requests: %#v err=%v", recent, err)
	}
	if recent[0].Provider != unsafeProvider || strings.Contains(recent[0].Error+recent[0].FallbackReason+recent[0].RouteDetail, urlSecret) {
		t.Fatalf("transport log lost identity or leaked URL error: %+v", recent[0])
	}
	select {
	case notification := <-mattermostPayload:
		if strings.Contains(notification, unsafeProvider) || strings.Contains(notification, urlSecret) {
			t.Fatalf("Mattermost notification leaked provider metadata: %s", notification)
		}
	case <-time.After(time.Second):
		t.Fatal("expected provider failure Mattermost notification")
	}
}

func TestLegacyUnsafeProviderFailoverPathIsBounded(t *testing.T) {
	primaryName := "sk-ant-primary-failover-secret"
	backupName := "sk-ant-backup-failover-secret"
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"temporary"}`)
	}))
	defer primary.Close()
	backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok","choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer backup.Close()

	server, db, gateway := newProviderBoundaryServer(t, primaryName)
	defer gateway.Close()
	key, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range []store.ProviderConfig{
		{Name: primaryName, BaseURL: primary.URL, EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*", Priority: 1},
		{Name: backupName, BaseURL: backup.URL, EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*", Priority: 2},
	} {
		if err := db.UpsertProvider(t.Context(), provider); err != nil {
			t.Fatal(err)
		}
	}
	response, err := http.Post(gateway.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	visible := string(body) + response.Header.Get("X-Provider") + response.Header.Get("X-Failover-From") + response.Header.Get("X-Failover-Path")
	if response.StatusCode != http.StatusOK || strings.Contains(visible, primaryName) || strings.Contains(visible, backupName) ||
		response.Header.Get("X-Failover-Path") == "" {
		t.Fatalf("unsafe failover metadata crossed response boundary: status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(t.Context(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent requests: %#v err=%v", recent, err)
	}
	decisions, err := db.ListRoutingDecisions(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if recent[0].Provider != backupName {
		t.Fatalf("served provider identity was lost: request=%+v", recent[0])
	}
	for _, decision := range decisions {
		if decision.SelectedProvider != backupName || strings.Contains(decision.DecisionReason+strings.Join(decision.FallbackPath, ","), primaryName) || strings.Contains(decision.DecisionReason+strings.Join(decision.FallbackPath, ","), backupName) {
			t.Fatalf("routing identity/metadata mismatch: %+v", decision)
		}
	}
}

func TestSessionHashRouteDetailBoundsLegacyUnsafeProvider(t *testing.T) {
	unsafeA := "sk-ant-session-a-secret"
	unsafeB := "sk-ant-session-b-secret"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok","choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer upstream.Close()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "provider-detail.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		logger.Stop(context.Background())
		db.Close()
	})
	cfg := testConfig(upstream.URL, "")
	cfg.Upstream.Provider = unsafeA
	cfg.Upstream.LoadBalance = "session_hash"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	key, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{unsafeA, unsafeB} {
		if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
			Name: name, BaseURL: upstream.URL, EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*",
		}); err != nil {
			t.Fatal(err)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, gateway.URL+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-ID", "provider-detail-boundary")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	visible := string(body) + response.Header.Get("X-Provider") + response.Header.Get("X-Route-Detail")
	if response.StatusCode != http.StatusOK || strings.Contains(visible, unsafeA) || strings.Contains(visible, unsafeB) ||
		!strings.Contains(response.Header.Get("X-Route-Detail"), boundedModelsProviderLabel(unsafeA)) {
		t.Fatalf("session-hash detail leaked/lost bounded provider: status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(t.Context(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 || strings.Contains(recent[0].RouteDetail, unsafeA) || strings.Contains(recent[0].RouteDetail, unsafeB) {
		t.Fatalf("unsafe session-hash detail persisted: requests=%+v err=%v", recent, err)
	}
}

func TestLegacyUnsafeProviderAuthDenialAuditIsBounded(t *testing.T) {
	unsafeProvider := "sk-ant-auth-denied-provider-secret"
	server, db, gateway := newProviderBoundaryServer(t, unsafeProvider)
	defer gateway.Close()
	key, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: unsafeProvider, BaseURL: "http://unused.invalid", EncryptedAPIKey: key, Enabled: true, ModelPatterns: "gpt-*",
	}); err != nil {
		t.Fatal(err)
	}
	created := postJSON(t, gateway.URL+"/admin/api-keys", "", map[string]any{
		"name": "restricted", "key": "restricted-secret", "allowed_providers": []string{"allowed-provider"},
	})
	created.Body.Close()
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create restricted API key status=%d", created.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPost, gateway.URL+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer restricted-secret")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden || strings.Contains(string(body), unsafeProvider) {
		t.Fatalf("auth denial leaked provider: status=%d body=%s", response.StatusCode, body)
	}
	events, err := db.ListAuditEvents(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.EventType == "model_denied" {
			found = true
			if strings.Contains(event.Detail, unsafeProvider) || !strings.Contains(event.Detail, boundedModelsProviderLabel(unsafeProvider)) {
				t.Fatalf("auth audit provider detail = %q", event.Detail)
			}
		}
	}
	if !found {
		t.Fatal("provider auth denial audit not recorded")
	}
}

func TestRoutingBalancerReleaseValidatesProviderWithoutEchoingInput(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "safe-provider", BaseURL: "https://example.invalid", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		body       any
		status     int
		code       string
		mustAbsent string
	}{
		{body: map[string]any{}, status: http.StatusBadRequest, code: "invalid_body"},
		{body: map[string]any{"provider": nil}, status: http.StatusBadRequest, code: "invalid_body"},
		{body: map[string]any{"provider": "unknown"}, status: http.StatusBadRequest, code: "balancer_provider_not_found"},
		{body: map[string]any{"provider": "sk-ant-balancer-secret"}, status: http.StatusBadRequest, code: "balancer_provider_invalid", mustAbsent: "sk-ant-balancer-secret"},
		{body: map[string]any{"provider": "safe-provider"}, status: http.StatusOK},
		{body: map[string]any{"provider": ""}, status: http.StatusOK},
	} {
		response := postJSON(t, gateway.URL+"/admin/routing/balancer", "", tc.body)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != tc.status || (tc.code != "" && !strings.Contains(string(body), tc.code)) ||
			(tc.mustAbsent != "" && strings.Contains(string(body), tc.mustAbsent)) {
			t.Fatalf("payload=%#v status=%d body=%s", tc.body, response.StatusCode, body)
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range audits {
		if strings.Contains(entry.BeforeValue+entry.AfterValue, "sk-ant-balancer-secret") {
			t.Fatalf("balancer audit leaked rejected provider: %+v", entry)
		}
	}
}

func TestOpsStatusAppProjectionAddsProviderReferenceWithoutRawLeak(t *testing.T) {
	unsafeProvider := "sk-ant-legacy-ops-provider-secret"
	server, db, gateway := newProviderBoundaryServer(t, "unused")
	defer gateway.Close()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: "req_ops_unsafe", TraceID: "trace_ops_unsafe", Method: http.MethodPost,
		Endpoint: "/v1/chat/completions", Model: "gpt-4o", Provider: unsafeProvider,
		StatusCode: http.StatusOK, CreatedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}
	response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/ops/status", nil)
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || strings.Contains(string(body), unsafeProvider) || !strings.Contains(string(body), server.providerRef(unsafeProvider)) {
		t.Fatalf("ops app projection leaked/lost provider identity: status=%d body=%s", response.StatusCode, body)
	}
}

func newProviderBoundaryServer(t *testing.T, defaultProvider string) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "provider-boundary.ndjson"))
	logger.Start()
	t.Cleanup(func() {
		logger.Stop(context.Background())
		db.Close()
	})
	cfg := testConfig("http://unused.invalid", "")
	cfg.Upstream.Provider = defaultProvider
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	return server, db, gateway
}
