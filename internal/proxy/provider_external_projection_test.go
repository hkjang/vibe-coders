package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSelfServiceReceiptsAlwaysBoundLegacyProviderMetadata(t *testing.T) {
	const (
		apiKey         = "self-service-secret"
		unsafeProvider = "sk-ant-legacy-self-service-secret"
		querySecret    = "self-service-query-secret"
	)
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig("http://upstream.invalid", "upstream-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "key_self_projection", Name: "self", KeyHash: hashProxyKey(apiKey),
		UserID: "user_self_projection", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: "req_self_projection", TraceID: "trace_self_projection", APIKeyID: "key_self_projection",
			Endpoint: "/v1/chat/completions", Model: "gpt-test", Provider: unsafeProvider,
			FallbackFrom: unsafeProvider, RouteDetail: unsafeProvider,
			FallbackReason: "dial https://provider.invalid/v1?api_key=" + querySecret,
			Error:          "provider " + unsafeProvider + " rejected token=" + querySecret,
			StatusCode:     http.StatusBadGateway, CreatedAt: now,
		},
		Routing: &store.RoutingDecisionLog{
			ID: "rdec_self_projection", RequestID: "req_self_projection", TraceID: "trace_self_projection",
			RequestedModel: "gpt-test", SelectedModel: "gpt-test", SelectedProvider: unsafeProvider,
			FallbackPath:   []string{unsafeProvider, "https://provider.invalid/v1?api_key=" + querySecret},
			DecisionReason: "selected " + unsafeProvider + " token=" + querySecret, CreatedAt: now,
		},
	}); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/me/requests", "/me/requests/req_self_projection/receipt"} {
		req, err := http.NewRequest(http.MethodGet, gateway.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, resp.StatusCode, body)
		}
		visible := string(body)
		if strings.Contains(visible, unsafeProvider) || strings.Contains(visible, querySecret) || strings.Contains(visible, "api_key") {
			t.Fatalf("GET %s leaked provider metadata: %s", path, visible)
		}
		if !strings.Contains(visible, boundedModelsProviderLabel(unsafeProvider)) {
			t.Fatalf("GET %s lost bounded provider label: %s", path, visible)
		}
	}
	persisted, err := db.RequestDetail(t.Context(), "req_self_projection")
	if err != nil {
		t.Fatal(err)
	}
	decision, err := db.RoutingDecisionByID(t.Context(), "req_self_projection")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Request.Provider != unsafeProvider || decision.SelectedProvider != unsafeProvider {
		t.Fatalf("external projection mutated internal identities: request=%q routing=%q", persisted.Request.Provider, decision.SelectedProvider)
	}
}

func TestGatewayExplainAndPreviewBoundLegacyProviderMetadata(t *testing.T) {
	const unsafeProvider = "sk-ant-legacy-mcp-gateway-secret"
	server, db, _ := newAdminModelsTestServer(t, "")
	encrypted, err := server.secrets.Load().Encrypt("upstream-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: unsafeProvider, BaseURL: "https://provider.invalid", EncryptedAPIKey: encrypted,
		Enabled: true, ModelPatterns: "gpt-mcp-*",
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{
		ID: "key_mcp_projection", Name: "mcp", KeyHash: hashProxyKey("mcp-secret"),
		UserID: "user_mcp_projection", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: "req_mcp_projection", TraceID: "trace_mcp_projection", APIKeyID: "key_mcp_projection",
			Endpoint: "/v1/chat/completions", Model: "gpt-mcp-test", Provider: unsafeProvider,
			StatusCode: http.StatusOK, CreatedAt: now,
		},
		Routing: &store.RoutingDecisionLog{
			ID: "rdec_mcp_projection", RequestID: "req_mcp_projection", TraceID: "trace_mcp_projection",
			RequestedModel: "gpt-mcp-test", SelectedModel: "gpt-mcp-test", SelectedProvider: unsafeProvider,
			FallbackPath: []string{unsafeProvider}, DecisionReason: "selected " + unsafeProvider, CreatedAt: now,
		},
	}); err != nil {
		t.Fatal(err)
	}

	authCtx := &store.AuthContext{APIKeyID: "key_mcp_projection", UserID: "user_mcp_projection"}
	request := httptest.NewRequest(http.MethodPost, "/mcp/gateway", nil)
	for _, test := range []struct {
		name string
		args map[string]any
	}{
		{name: "gateway_explain_request", args: map[string]any{"request_id": "req_mcp_projection"}},
		{name: "gateway_route_preview", args: map[string]any{"model": "gpt-mcp-test", "prompt": "hello"}},
	} {
		encoded, _ := json.Marshal(test.args)
		result, err := server.runGatewayTool(t.Context(), request, authCtx.APIKeyID, authCtx, test.name, encoded)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		visibleBytes, _ := json.Marshal(result)
		visible := string(visibleBytes)
		if strings.Contains(visible, unsafeProvider) || !strings.Contains(visible, boundedModelsProviderLabel(unsafeProvider)) {
			t.Fatalf("%s provider projection failed: %s", test.name, visible)
		}
	}
}
