package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

const connectionTestPath = "/admin/provider-connection-test"

type connectionTestResult struct {
	Outcome        string `json:"outcome"`
	UpstreamStatus *int   `json:"upstream_status"`
	DurationMS     int64  `json:"duration_ms"`
	TimeoutMS      int    `json:"timeout_ms"`
	ModelCount     *int   `json:"model_count"`
}

func connectionPost(t *testing.T, gateway, token string, payload any) (int, connectionTestResult, string) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return connectionPostRaw(t, gateway, token, string(body))
}

func connectionPostRaw(t *testing.T, gateway, token, body string) (int, connectionTestResult, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, gateway+connectionTestPath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var result connectionTestResult
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || len(fields) != 5 {
			t.Fatalf("unexpected response fields: %s", raw)
		}
		if result.DurationMS < 0 || result.TimeoutMS < 1 || result.TimeoutMS > 10000 {
			t.Fatalf("invalid duration bounds: %+v", result)
		}
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("connection test response must not be cached (status %d)", resp.StatusCode)
	}
	return resp.StatusCode, result, string(raw)
}

func newConnectionTestServer(t *testing.T) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	server, db, gateway := newAdminModelsTestServer(t, "")
	setAppUITelemetryTestSetting(t, server, appUIEnabledKey, "true")
	return server, db, gateway
}

func TestProviderConnectionTestDraftUsesFreshFixedPathWithoutSaving(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/base/v1/models" || r.URL.RawQuery != "api-version=2026-01" {
			t.Errorf("unexpected catalogue target: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer draft-secret-value" || r.Header.Get("Accept") != "application/json" {
			t.Error("draft credentials or catalogue accept header not used")
		}
		w.Header().Set("X-Upstream-Secret", "forbidden-response-header")
		_, _ = io.WriteString(w, `{"data":[{"id":"private-model-id"}]}`)
	}))
	t.Cleanup(upstream.Close)
	server, db, gateway := newConnectionTestServer(t)
	before, err := db.ListProviders(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		status, result, body := connectionPost(t, gateway.URL, "", map[string]any{
			"name": "new-provider", "base_url": upstream.URL + "/base?api-version=2026-01", "credential_mode": "draft", "api_key": "draft-secret-value", "timeout_ms": 600000,
		})
		if status != 200 || result.Outcome != "catalog_available" || result.ModelCount == nil || *result.ModelCount != 1 || result.UpstreamStatus == nil || *result.UpstreamStatus != 200 || result.TimeoutMS != 10000 {
			t.Fatalf("connection test failed: status=%d body=%s", status, body)
		}
		for _, forbidden := range []string{upstream.URL, "draft-secret-value", "private-model-id", "new-provider", "forbidden-response-header"} {
			if strings.Contains(body, forbidden) {
				t.Fatal("connection response contains private input or upstream output")
			}
		}
	}
	after, err := db.ListProviders(t.Context())
	if err != nil || !reflect.DeepEqual(before, after) || calls.Load() != 2 {
		t.Fatalf("probe saved provider configuration or reused cache: calls=%d err=%v", calls.Load(), err)
	}
	server.adminModels.mu.Lock()
	cacheEntries := len(server.adminModels.entries)
	server.adminModels.mu.Unlock()
	if cacheEntries != 0 {
		t.Fatal("probe modified shared model cache")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 2 {
		t.Fatalf("expected two connection action audits: count=%d err=%v", len(audits), err)
	}
	for _, audit := range audits {
		if audit.Action != "provider.connection_test" || audit.BeforeValue != "" {
			t.Fatalf("unexpected audit action: %s", audit.Action)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(audit.AfterValue), &fields); err != nil || len(fields) != 5 {
			t.Fatal("audit must contain only the fixed result DTO")
		}
	}
}

func TestProviderConnectionTestMalformedFeatureSettingFailsClosed(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	t.Cleanup(upstream.Close)
	server, _, gateway := newConnectionTestServer(t)
	setAppUITelemetryTestSetting(t, server, "ui.app.feature.gateway.providers.readonly", "invalid")
	status, _, body := connectionPost(t, gateway.URL, "", map[string]any{"name": "new-provider", "base_url": upstream.URL, "credential_mode": "none"})
	if status != 503 || !strings.Contains(body, "provider_connection_unavailable") || calls.Load() != 0 {
		t.Fatalf("malformed settings allowed execution: status=%d calls=%d", status, calls.Load())
	}
}
