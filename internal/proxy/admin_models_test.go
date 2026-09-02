package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func newAdminModelsTestServer(t *testing.T, adminToken string) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "admin-models.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.AdminToken = adminToken
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(server.Routes())
	t.Cleanup(testServer.Close)
	return server, db, testServer
}

func addAdminModelsProvider(t *testing.T, server *Server, db *store.SQLStore, provider store.ProviderConfig, apiKey string) {
	t.Helper()
	if apiKey != "" {
		encrypted, err := server.secrets.Load().Encrypt(apiKey)
		if err != nil {
			t.Fatal(err)
		}
		provider.EncryptedAPIKey = encrypted
	}
	if err := db.UpsertProvider(t.Context(), provider); err != nil {
		t.Fatal(err)
	}
}

func getAdminModels(t *testing.T, url, token string) (*http.Response, adminModelsResponse) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body adminModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return resp, body
}

func TestAdminModelsNormalizesConcurrentProviderInventory(t *testing.T) {
	var arrivals atomic.Int32
	var alphaCalls atomic.Int32
	var zetaCalls atomic.Int32
	release := make(chan struct{})
	var releaseOnce sync.Once
	upstream := func(provider string, calls *atomic.Int32, payload string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			wantPath := "/v1/models"
			if provider == "zeta" {
				wantPath = "/gateway/v1/models"
			}
			if r.URL.Path != wantPath || r.URL.RawQuery != "" {
				t.Errorf("%s upstream request = %s?%s, want %s without query", provider, r.URL.Path, r.URL.RawQuery, wantPath)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if got := r.Header.Get("Authorization"); got != "Bearer key-"+provider {
				t.Errorf("%s Authorization = %q", provider, got)
			}
			if arrivals.Add(1) == 2 {
				releaseOnce.Do(func() { close(release) })
			}
			select {
			case <-release:
			case <-time.After(2 * time.Second):
				w.WriteHeader(http.StatusGatewayTimeout)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, payload)
		}))
	}
	alpha := upstream("alpha", &alphaCalls, `{"data":[{"id":"shared","object":"model","owned_by":"owner-alpha","created":123},{"id":"dead-model"},{"id":"shared"},{"id":""}]}`)
	defer alpha.Close()
	zeta := upstream("zeta", &zetaCalls, `{"data":[{"id":"shared","created":"not-a-number"},{"id":"old-model"},{"id":"future-model"}]}`)
	defer zeta.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "zeta", BaseURL: zeta.URL + "/gateway", TimeoutMS: 2_000, Enabled: true,
	}, "key-zeta")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "alpha", BaseURL: alpha.URL, TimeoutMS: 2_000, Enabled: true,
	}, "key-alpha")
	for _, deprecation := range []store.ModelDeprecation{
		{ModelGlob: "future-*", Replacement: "future-v2", SunsetDate: "2099-01-01", Message: "move later"},
		{ModelGlob: "old-*", Replacement: "new-model", SunsetDate: "2000-01-01", Message: "moved"},
		{ModelGlob: "dead-*", SunsetDate: "2000-01-01", Message: "removed"},
	} {
		if _, err := db.UpsertModelDeprecation(t.Context(), deprecation); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-enabled", VirtualModel: "vibe/research", Name: "Research", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-disabled", VirtualModel: "vibe/hidden", Name: "Hidden", Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}

	resp, body := getAdminModels(t, gateway.URL+"/admin/models", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if body.RequestID == "" || body.RequestID != resp.Header.Get("X-Request-ID") {
		t.Fatalf("body request_id %q does not match header %q", body.RequestID, resp.Header.Get("X-Request-ID"))
	}
	if _, err := time.Parse(time.RFC3339Nano, body.GeneratedAt); err != nil {
		t.Fatalf("generated_at = %q: %v", body.GeneratedAt, err)
	}
	if len(body.Models) != 6 {
		t.Fatalf("models = %+v, want 6 distinct source/provider/id rows", body.Models)
	}
	wantOrder := []string{
		"alpha/dead-model/live", "alpha/shared/live", "vibe/vibe/research/agent_route",
		"zeta/future-model/live", "zeta/old-model/live", "zeta/shared/live",
	}
	gotOrder := make([]string, 0, len(body.Models))
	for _, model := range body.Models {
		gotOrder = append(gotOrder, model.Provider+"/"+model.ID+"/"+string(model.Source))
		if model.Stale {
			t.Fatalf("newly fetched model marked stale: %+v", model)
		}
		if _, err := time.Parse(time.RFC3339Nano, model.FetchedAt); err != nil {
			t.Fatalf("model fetched_at = %q: %v", model.FetchedAt, err)
		}
	}
	// The expected count above includes two provider-specific rows for shared. Confirm the
	// actual deterministic prefix/order without coupling the test to map iteration.
	if strings.Join(gotOrder, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("model order = %v, want %v", gotOrder, wantOrder)
	}

	findModel := func(provider, id string) adminModel {
		t.Helper()
		for _, model := range body.Models {
			if model.Provider == provider && model.ID == id {
				return model
			}
		}
		t.Fatalf("missing model %s/%s", provider, id)
		return adminModel{}
	}
	alphaShared := findModel("alpha", "shared")
	if alphaShared.Created == nil || *alphaShared.Created != 123 || alphaShared.OwnedBy != "owner-alpha" || alphaShared.Virtual {
		t.Fatalf("normalized alpha/shared = %+v", alphaShared)
	}
	zetaShared := findModel("zeta", "shared")
	if zetaShared.Created != nil || zetaShared.OwnedBy != "zeta" {
		t.Fatalf("normalized zeta/shared = %+v", zetaShared)
	}
	virtual := findModel("vibe", "vibe/research")
	if !virtual.Virtual || virtual.Source != adminModelSourceAgentRoute || virtual.Created != nil {
		t.Fatalf("virtual model = %+v", virtual)
	}
	if got := findModel("zeta", "future-model").Deprecation; got == nil || got.Action != "warn" || got.SunsetReached || got.Retired {
		t.Fatalf("future deprecation = %+v", got)
	}
	if got := findModel("zeta", "old-model").Deprecation; got == nil || got.Action != "rewrite" || !got.SunsetReached || !got.Retired {
		t.Fatalf("replacement deprecation = %+v", got)
	}
	if got := findModel("alpha", "dead-model").Deprecation; got == nil || got.Action != "block" || !got.Retired {
		t.Fatalf("retired deprecation = %+v", got)
	}
	if len(body.Providers) != 3 || len(body.PartialFailures) != 0 {
		t.Fatalf("providers=%+v failures=%+v", body.Providers, body.PartialFailures)
	}
	if alphaCalls.Load() != 1 || zetaCalls.Load() != 1 {
		t.Fatalf("provider calls alpha=%d zeta=%d", alphaCalls.Load(), zetaCalls.Load())
	}

	_, filtered := getAdminModels(t, gateway.URL+"/admin/models?provider=alpha&model=shared", "")
	if len(filtered.Models) != 1 || filtered.Models[0].Provider != "alpha" || filtered.Models[0].ID != "shared" {
		t.Fatalf("exact filters returned %+v", filtered.Models)
	}
	if len(filtered.Providers) != 1 || filtered.Providers[0].Provider != "alpha" || filtered.Providers[0].ModelCount != 1 {
		t.Fatalf("filtered providers = %+v", filtered.Providers)
	}
	if alphaCalls.Load() != 2 || zetaCalls.Load() != 1 {
		t.Fatalf("provider filter calls alpha=%d zeta=%d", alphaCalls.Load(), zetaCalls.Load())
	}

	_, duplicated := getAdminModels(t, gateway.URL+"/admin/models?model=shared", "")
	if len(duplicated.Models) != 2 || duplicated.Models[0].Provider != "alpha" || duplicated.Models[1].Provider != "zeta" {
		t.Fatalf("model filter must preserve provider/model pairs: %+v", duplicated.Models)
	}

	beforeAlpha, beforeZeta := alphaCalls.Load(), zetaCalls.Load()
	respMissing, err := http.Get(gateway.URL + "/admin/models/not-an-exact-route")
	if err != nil {
		t.Fatal(err)
	}
	defer respMissing.Body.Close()
	if respMissing.StatusCode != http.StatusNotFound {
		t.Fatalf("nested admin models path status = %d, want 404", respMissing.StatusCode)
	}
	if alphaCalls.Load() != beforeAlpha || zetaCalls.Load() != beforeZeta {
		t.Fatal("non-exact admin models path reached providers")
	}
}

func TestAdminModelsReturnsSanitizedPartialFailuresEvenWhenAllProvidersFail(t *testing.T) {
	const rawDiagnostic = "upstream-private-diagnostic-123"
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, rawDiagnostic)
	}))
	defer failing.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "failed", BaseURL: failing.URL, TimeoutMS: 1_000, Enabled: true,
	}, "provider-secret")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "skipped", BaseURL: "https://skipped.internal.example", TimeoutMS: 1_000, Enabled: true,
	}, "")

	resp, body := getAdminModels(t, gateway.URL+"/admin/models", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 for an all-provider partial failure", resp.StatusCode)
	}
	if body.Models == nil || body.Providers == nil || body.PartialFailures == nil {
		t.Fatalf("contract arrays must be non-null: %+v", body)
	}
	if len(body.Models) != 0 || len(body.Providers) != 2 || len(body.PartialFailures) != 2 {
		t.Fatalf("all-failed body = %+v", body)
	}
	if body.Providers[0].Provider != "failed" || body.Providers[0].Status != "failed" || body.Providers[0].Stale {
		t.Fatalf("failed provider summary = %+v", body.Providers[0])
	}
	if body.Providers[1].Provider != "skipped" || body.Providers[1].Status != "skipped" || body.Providers[1].Stale {
		t.Fatalf("skipped provider summary = %+v", body.Providers[1])
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{rawDiagnostic, "provider-secret", "skipped.internal.example"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("partial failure exposed %q: %s", secret, encoded)
		}
	}
	if body.PartialFailures[0].Code != "provider_models_unavailable" || body.PartialFailures[1].Code != "provider_credentials_unavailable" {
		t.Fatalf("sanitized failures = %+v", body.PartialFailures)
	}
}

func TestAdminModelsRequiresAdminReadAndNeverCachesErrors(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "admin-secret")

	resp, err := http.Get(gateway.URL + "/admin/models")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unauthorized response status=%d cache=%q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}

	req, err := http.NewRequest(http.MethodPost, gateway.URL+"/admin/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer admin-secret")
	methodResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer methodResp.Body.Close()
	if methodResp.StatusCode != http.StatusMethodNotAllowed || methodResp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("method response status=%d cache=%q", methodResp.StatusCode, methodResp.Header.Get("Cache-Control"))
	}
}

func TestAdminModelsRequiresAdminReadScope(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "admin-models-scope.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "admin-models-scope-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)

	now := time.Now().UTC()
	tokenFor := func(sessionID string, scopes []string) string {
		t.Helper()
		if err := db.InsertAuthSession(t.Context(), sessionID, "user-"+sessionID, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		token, err := server.signAccessToken(accessClaims{
			Subject: "user-" + sessionID, Role: "custom", Scopes: scopes, SessionID: sessionID,
			Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}

	for _, test := range []struct {
		name   string
		token  string
		status int
	}{
		{name: "models read alone is insufficient", token: tokenFor("models-only", []string{"models:read"}), status: http.StatusUnauthorized},
		{name: "admin read is accepted", token: tokenFor("admin-read", []string{"admin:read"}), status: http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, gateway.URL+"/admin/models", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+test.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != test.status {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d body=%s, want %d", resp.StatusCode, body, test.status)
			}
		})
	}
}

func TestAdminModelsProviderConfigurationFailureIsServerError(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(gateway.URL + "/admin/models")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%s, want 500", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", resp.Header.Get("Cache-Control"))
	}
}

func TestAdminModelsProviderTimeoutIsBounded(t *testing.T) {
	tests := []struct {
		name     string
		provider store.ProviderConfig
		fallback time.Duration
		want     time.Duration
	}{
		{name: "provider smaller", provider: store.ProviderConfig{TimeoutMS: 750}, fallback: 5 * time.Second, want: 750 * time.Millisecond},
		{name: "fallback smaller", provider: store.ProviderConfig{}, fallback: 3 * time.Second, want: 3 * time.Second},
		{name: "provider capped", provider: store.ProviderConfig{TimeoutMS: 60_000}, fallback: time.Second, want: 10 * time.Second},
		{name: "fallback capped", provider: store.ProviderConfig{}, fallback: time.Minute, want: 10 * time.Second},
		{name: "invalid uses cap", provider: store.ProviderConfig{}, fallback: 0, want: 10 * time.Second},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := adminModelsProviderTimeout(test.provider, test.fallback); got != test.want {
				t.Fatalf("timeout = %s, want %s", got, test.want)
			}
		})
	}
}

func TestNormalizedModelCreatedRejectsNonIntegralAndOverflowValues(t *testing.T) {
	if got := normalizedModelCreated(float64(123)); got == nil || *got != 123 {
		t.Fatalf("created = %v, want 123", got)
	}
	for _, value := range []any{nil, "123", float64(1.5), float64(9_223_372_036_854_775_808)} {
		if got := normalizedModelCreated(value); got != nil {
			t.Errorf("normalizedModelCreated(%v) = %d, want nil", value, *got)
		}
	}
}
