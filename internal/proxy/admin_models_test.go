package proxy

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func newAdminModelsTestServer(t *testing.T, adminToken string) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	server, testServer := serveAdminModelsTestStore(t, adminToken, db)
	return server, db, testServer
}

func serveAdminModelsTestStore(t *testing.T, adminToken string, db *store.SQLStore) (*Server, *httptest.Server) {
	t.Helper()
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
	return server, testServer
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
	const adminCallerSecret = "ADMIN-CALLER-MODELS-SECRET"
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
			wantQuery := ""
			if provider == "zeta" {
				wantQuery = "api-version=2026-01-01&region=koreacentral"
			}
			if r.URL.Path != wantPath || r.URL.RawQuery != wantQuery {
				t.Errorf("%s upstream request = %s?%s, want %s?%s", provider, r.URL.Path, r.URL.RawQuery, wantPath, wantQuery)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if got := r.Header.Get("Authorization"); got != "Bearer key-"+provider {
				t.Errorf("%s Authorization = %q", provider, got)
			}
			for _, header := range []string{"Cookie", "X-Api-Key", "X-Admin-Token", "X-Vendor-Auth"} {
				if got := r.Header.Get(header); got != "" {
					t.Errorf("%s forwarded admin caller %s=%q", provider, header, got)
				}
			}
			if strings.Contains(r.Header.Get("Authorization"), adminCallerSecret) {
				t.Errorf("%s forwarded admin caller authorization", provider)
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
		Name: "zeta", BaseURL: zeta.URL + "/gateway?api-version=2026-01-01&region=koreacentral", TimeoutMS: 2_000, Enabled: true,
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
		ID: "agent-shadow", VirtualModel: "shared", Name: "Shadow", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-disabled", VirtualModel: "old-model", Name: "Disabled", Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequest(http.MethodGet, gateway.URL+"/admin/models?api_key="+adminCallerSecret+"&vendor_hint=private", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+adminCallerSecret)
	request.Header.Set("Cookie", "session="+adminCallerSecret)
	request.Header.Set("X-Api-Key", adminCallerSecret)
	request.Header.Set("X-Admin-Token", adminCallerSecret)
	request.Header.Set("X-Vendor-Auth", adminCallerSecret)
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body adminModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
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
	if len(body.Models) != 7 {
		t.Fatalf("models = %+v, want 7 distinct source/provider/id rows", body.Models)
	}
	wantOrder := []string{
		"alpha/dead-model/live", "alpha/shared/live", "vibe/shared/agent_route", "vibe/vibe/research/agent_route",
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
	if alphaShared.Created == nil || *alphaShared.Created != 123 || alphaShared.OwnedBy != "owner-alpha" || alphaShared.Virtual || !alphaShared.Shadowed || alphaShared.ShadowedBy != "agent-shadow" {
		t.Fatalf("normalized alpha/shared = %+v", alphaShared)
	}
	zetaShared := findModel("zeta", "shared")
	if zetaShared.Created != nil || zetaShared.OwnedBy != "zeta" || !zetaShared.Shadowed || zetaShared.ShadowedBy != "agent-shadow" {
		t.Fatalf("normalized zeta/shared = %+v", zetaShared)
	}
	virtual := findModel("vibe", "vibe/research")
	if !virtual.Virtual || virtual.Source != adminModelSourceAgentRoute || virtual.Created != nil || virtual.Shadowed || virtual.ShadowedBy != "" {
		t.Fatalf("virtual model = %+v", virtual)
	}
	shadowingRoute := findModel("vibe", "shared")
	if !shadowingRoute.Virtual || shadowingRoute.Shadowed || shadowingRoute.ShadowedBy != "" {
		t.Fatalf("shadowing agent model = %+v", shadowingRoute)
	}
	if physical := findModel("zeta", "old-model"); physical.Shadowed || physical.ShadowedBy != "" {
		t.Fatalf("disabled agent route shadowed a physical model: %+v", physical)
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
	if len(filtered.Models) != 1 || filtered.Models[0].Provider != "alpha" || filtered.Models[0].ID != "shared" || !filtered.Models[0].Shadowed || filtered.Models[0].ShadowedBy != "agent-shadow" {
		t.Fatalf("exact filters returned %+v", filtered.Models)
	}
	if len(filtered.Providers) != 1 || filtered.Providers[0].Provider != "alpha" || filtered.Providers[0].ModelCount != 1 {
		t.Fatalf("filtered providers = %+v", filtered.Providers)
	}
	if alphaCalls.Load() != 1 || zetaCalls.Load() != 1 {
		t.Fatalf("provider filter calls alpha=%d zeta=%d", alphaCalls.Load(), zetaCalls.Load())
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-shadow", VirtualModel: "shared", Name: "Shadow", Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	_, noLongerShadowed := getAdminModels(t, gateway.URL+"/admin/models?provider=alpha&model=shared", "")
	if len(noLongerShadowed.Models) != 1 || noLongerShadowed.Models[0].Shadowed || noLongerShadowed.Models[0].ShadowedBy != "" {
		t.Fatalf("disabled route left a cached physical model shadowed: %+v", noLongerShadowed.Models)
	}
	if alphaCalls.Load() != 1 {
		t.Fatalf("route-only change unexpectedly refetched the provider %d times", alphaCalls.Load())
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-shadow", VirtualModel: "shared", Name: "Shadow", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	_, duplicated := getAdminModels(t, gateway.URL+"/admin/models?model=shared", "")
	if len(duplicated.Models) != 3 || duplicated.Models[0].Provider != "alpha" || duplicated.Models[1].Provider != "vibe" || duplicated.Models[2].Provider != "zeta" {
		t.Fatalf("model filter must preserve provider/model pairs: %+v", duplicated.Models)
	}
	if duplicated.Models[1].Shadowed || duplicated.Models[1].ShadowedBy != "" {
		t.Fatalf("agent route row must not shadow itself: %+v", duplicated.Models[1])
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

func TestAdminModelsKeepsPhysicalRowsWhenAgentRouteCatalogFails(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "agent-route-unavailable.db")
	db, err := store.Open(t.Context(), config.DatabaseConfig{Driver: "sqlite", DSN: databasePath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"physical-model"}]}`)
	}))
	t.Cleanup(upstream.Close)
	server, gateway := serveAdminModelsTestStore(t, "", db)
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "alpha", BaseURL: upstream.URL, TimeoutMS: 1_000, Enabled: true,
	}, "alpha-secret")

	rawDB, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rawDB.ExecContext(t.Context(), "DROP TABLE agent_routes"); err != nil {
		_ = rawDB.Close()
		t.Fatal(err)
	}
	if err := rawDB.Close(); err != nil {
		t.Fatal(err)
	}

	resp, body := getAdminModels(t, gateway.URL+"/admin/models?provider=alpha&model=physical-model", "")
	if resp.StatusCode != http.StatusOK || len(body.Models) != 1 {
		t.Fatalf("status=%d body=%+v, want the physical model", resp.StatusCode, body)
	}
	if body.Models[0].Shadowed || body.Models[0].ShadowedBy != "" {
		t.Fatalf("unknown shadow state must retain safe zero values: %+v", body.Models[0])
	}
	if len(body.Providers) != 1 || body.Providers[0].Provider != "alpha" || body.Providers[0].Status != "ok" {
		t.Fatalf("physical provider was blocked by the route failure: %+v", body.Providers)
	}
	if len(body.PartialFailures) != 1 || body.PartialFailures[0] != (adminModelPartialFailure{
		Provider: "vibe", ProviderRef: server.systemProviderRef("vibe"), Code: "agent_routes_unavailable", Message: "Virtual model catalog is unavailable.",
	}) {
		t.Fatalf("agent route failure was not sanitized: %+v", body.PartialFailures)
	}

	_, unfiltered := getAdminModels(t, gateway.URL+"/admin/models", "")
	if len(unfiltered.Models) != 1 || len(unfiltered.Providers) != 2 || len(unfiltered.PartialFailures) != 1 {
		t.Fatalf("unfiltered partial result = %+v", unfiltered)
	}
	if unfiltered.Providers[1].Provider != "vibe" || unfiltered.Providers[1].Status != "failed" {
		t.Fatalf("virtual provider failure summary = %+v", unfiltered.Providers)
	}
}

func TestAdminModelShadowFieldsAreAlwaysEncoded(t *testing.T) {
	encoded, err := json.Marshal(adminModel{})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["shadowed"]) != "false" || string(fields["shadowed_by"]) != `""` {
		t.Fatalf("required zero-value shadow fields missing from %s", encoded)
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

func TestAdminModelsBoundsLegacyProviderLabelsAcrossLiveStaleAndFailures(t *testing.T) {
	const (
		unsafeA    = "sk-ant-first-provider-secret"
		unsafeB    = "Bearer second-provider-secret"
		unsafeFail = "token=failed-provider-secret"
		safeName   = "safe-provider"
	)
	var failLive atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if failLive.Load() || key == "key-fail" {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "private upstream failure")
			return
		}
		id := "shared"
		if key == "key-safe" {
			id = "safe-model"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": id}}})
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	for _, provider := range []struct {
		name string
		key  string
	}{
		{unsafeA, "key-a"}, {unsafeB, "key-b"}, {unsafeFail, "key-fail"}, {safeName, "key-safe"},
	} {
		addAdminModelsProvider(t, server, db, store.ProviderConfig{
			Name: provider.name, BaseURL: upstream.URL, TimeoutMS: 1_000, Enabled: true,
		}, provider.key)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-shadow", VirtualModel: "shared", Name: "Shadow", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, 9, 3, 1, 0, 0, 0, time.UTC)
	var clock atomic.Int64
	clock.Store(baseTime.UnixNano())
	server.adminModels.now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	server.adminModels.freshTTL = time.Second
	server.adminModels.staleTTL = time.Minute

	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)

	assertNoRawNames := func(label string, response *http.Response, body adminModelsResponse) {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		observed := string(encoded) + logs.String()
		for key, values := range response.Header {
			observed += key + strings.Join(values, "")
		}
		for _, raw := range []string{unsafeA, unsafeB, unsafeFail} {
			if strings.Contains(observed, raw) {
				t.Fatalf("%s leaked legacy provider name %q: %s", label, raw, observed)
			}
		}
	}

	response, live := getAdminModels(t, gateway.URL+"/admin/models", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("live status = %d", response.StatusCode)
	}
	assertNoRawNames("live", response, live)
	placeholderProviders := 0
	placeholderRefs := map[string]bool{}
	for _, provider := range live.Providers {
		if provider.Provider == "[provider-name-omitted]" {
			placeholderProviders++
			placeholderRefs[provider.ProviderRef] = true
		}
		if provider.Provider == safeName && provider.ProviderRef != server.providerRef(safeName) {
			t.Fatalf("safe provider_ref = %q", provider.ProviderRef)
		}
	}
	if placeholderProviders != 3 || len(placeholderRefs) != 3 {
		t.Fatalf("unsafe provider summaries = %+v", live.Providers)
	}
	physicalShared := 0
	physicalRefs := map[string]bool{}
	for _, model := range live.Models {
		switch {
		case model.Source == adminModelSourceLive && model.ID == "shared":
			physicalShared++
			physicalRefs[model.ProviderRef] = true
			if model.Provider != "[provider-name-omitted]" || model.OwnedBy != "[provider-name-omitted]" || !model.Shadowed {
				t.Fatalf("unsafe live model was not bounded: %+v", model)
			}
		case model.ID == "safe-model":
			if model.Provider != safeName || model.OwnedBy != safeName || model.ProviderRef != server.providerRef(safeName) {
				t.Fatalf("safe provider label changed: %+v", model)
			}
		case model.Source == adminModelSourceAgentRoute:
			if model.ProviderRef != server.systemProviderRef("vibe") {
				t.Fatalf("agent route provider_ref = %q", model.ProviderRef)
			}
		}
	}
	if physicalShared != 2 || len(physicalRefs) != 2 {
		t.Fatalf("colliding display labels merged raw provider identities: %+v", live.Models)
	}
	if len(live.PartialFailures) != 1 || live.PartialFailures[0].Provider != "[provider-name-omitted]" || live.PartialFailures[0].ProviderRef != server.providerRef(unsafeFail) {
		t.Fatalf("unsafe failure provider was not bounded: %+v", live.PartialFailures)
	}
	server.adminModels.mu.Lock()
	_, cachedA := server.adminModels.entries[unsafeA]
	_, cachedB := server.adminModels.entries[unsafeB]
	server.adminModels.mu.Unlock()
	if !cachedA || !cachedB {
		t.Fatal("unsafe providers collided as internal cache identities")
	}

	filteredResponse, filtered := getAdminModels(t, gateway.URL+"/admin/models?provider="+url.QueryEscape(unsafeA), "")
	assertNoRawNames("filtered", filteredResponse, filtered)
	if len(filtered.Models) != 1 || filtered.Models[0].Provider != "[provider-name-omitted]" || filtered.Models[0].ProviderRef != server.providerRef(unsafeA) || filtered.Models[0].ID != "shared" {
		t.Fatalf("raw provider filter did not preserve internal identity: %+v", filtered.Models)
	}

	failLive.Store(true)
	clock.Store(baseTime.Add(2 * time.Second).UnixNano())
	logs.Reset()
	staleResponse, stale := getAdminModels(t, gateway.URL+"/admin/models", "")
	assertNoRawNames("stale", staleResponse, stale)
	if len(stale.PartialFailures) != 4 {
		t.Fatalf("stale/failure summaries = %+v", stale.PartialFailures)
	}
	for _, failure := range stale.PartialFailures {
		if failure.Provider != "[provider-name-omitted]" && failure.Provider != safeName {
			t.Fatalf("stale failure leaked or changed provider label: %+v", failure)
		}
		if len(failure.ProviderRef) != providerRefLength {
			t.Fatalf("stale failure has invalid provider_ref: %+v", failure)
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 50)
	if err != nil {
		t.Fatal(err)
	}
	encodedAudits, _ := json.Marshal(audits)
	for _, raw := range []string{unsafeA, unsafeB, unsafeFail} {
		if strings.Contains(string(encodedAudits), raw) {
			t.Fatalf("admin models audit leaked legacy provider name %q: %s", raw, encodedAudits)
		}
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

func TestAdminModelsCatalogRefreshTimeoutIsBounded(t *testing.T) {
	for _, test := range []struct {
		name       string
		configured time.Duration
		want       time.Duration
	}{
		{name: "smaller timeout", configured: 3 * time.Second, want: 3 * time.Second},
		{name: "zero uses cap", configured: 0, want: adminModelsCatalogRefreshTimeout},
		{name: "larger uses cap", configured: time.Minute, want: adminModelsCatalogRefreshTimeout},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := boundedAdminModelsCatalogRefreshTimeout(test.configured); got != test.want {
				t.Fatalf("refresh timeout = %s, want %s", got, test.want)
			}
		})
	}
}

func TestAdminModelsReportsProviderDecodeLimitWithStableFailure(t *testing.T) {
	payload := providerCatalogPayload("bounded-", maxModelsPerProvider+1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "too-many", BaseURL: upstream.URL, TimeoutMS: 2_000, Enabled: true,
	}, "private-catalog-key")

	response, body := getAdminModels(t, gateway.URL+"/admin/models", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if len(body.Models) != 0 || len(body.Providers) != 1 || body.Providers[0].Status != "failed" {
		t.Fatalf("decode-limited catalogue response = %+v", body)
	}
	if len(body.PartialFailures) != 1 || body.PartialFailures[0].Provider != "too-many" || body.PartialFailures[0].Code != "provider_models_limit_exceeded" {
		t.Fatalf("decode limit partial failure = %+v", body.PartialFailures)
	}
	if body.PartialFailures[0].Message != "Provider model catalog exceeds the supported limit." {
		t.Fatalf("decode limit message was not sanitized: %q", body.PartialFailures[0].Message)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private-catalog-key") {
		t.Fatalf("decode limit response exposed credential: %s", encoded)
	}
}

func TestAdminModelsResponseLimiterCapsRowsAndEncodedBytes(t *testing.T) {
	providerRef := func(string) string { return providerRefPrefix + strings.Repeat("a", 43) }
	response := adminModelsResponse{Models: []adminModel{}}
	limiter := newAdminModelsResponseLimiter(providerRef)
	for index := range maxAdminModelsResponseRows + 1 {
		limiter.append(&response, adminModel{
			ID: "model-" + strconv.Itoa(index), Provider: "provider", Object: "model", OwnedBy: "provider", Source: adminModelSourceLive,
		})
	}
	if len(response.Models) != maxAdminModelsResponseRows || !limiter.limited {
		t.Fatalf("response limiter rows=%d limited=%v, want rows=%d limited", len(response.Models), limiter.limited, maxAdminModelsResponseRows)
	}
	if limiter.modelBytes > maxAdminModelsResponseModelBytes {
		t.Fatalf("model payload bytes = %d, cap %d", limiter.modelBytes, maxAdminModelsResponseModelBytes)
	}

	oversized := adminModelsResponse{
		RequestID: "request", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Models: []adminModel{}, Providers: []adminModelProvider{},
		PartialFailures: []adminModelPartialFailure{{Provider: "*", Code: "oversized", Message: strings.Repeat("x", maxAdminModelsResponseBytes)}},
	}
	recorder := httptest.NewRecorder()
	writeAdminModelsResponse(recorder, oversized, providerRef)
	if recorder.Code != http.StatusServiceUnavailable || recorder.Body.Len() >= maxAdminModelsResponseBytes {
		t.Fatalf("oversized response status=%d bytes=%d", recorder.Code, recorder.Body.Len())
	}
}

func TestAdminModelsResponseLimiterUsesFinalSanitizedModelSize(t *testing.T) {
	providerRef := func(string) string { return providerRefPrefix + strings.Repeat("r", 43) }
	unsafeName := "sk-ant-shortsecret"
	base := adminModel{
		Provider: unsafeName, Object: "model", OwnedBy: unsafeName, Source: adminModelSourceLive,
	}
	finalBase, err := json.Marshal(finalizeAdminModelForResponse(base, providerRef))
	if err != nil {
		t.Fatal(err)
	}
	// This candidate fits if raw DTO bytes are counted, but exceeds the model budget
	// once provider_ref and the longer redacted display labels are serialized.
	candidate := base
	candidate.ID = strings.Repeat("x", maxAdminModelsResponseModelBytes-len(finalBase)+1)
	raw, _ := json.Marshal(candidate)
	if len(raw)+1 > maxAdminModelsResponseModelBytes {
		t.Fatalf("test candidate raw bytes=%d do not demonstrate pre-sanitize fit", len(raw)+1)
	}
	response := adminModelsResponse{Models: []adminModel{}}
	limiter := newAdminModelsResponseLimiter(providerRef)
	if limiter.append(&response, candidate) || !limiter.limited || len(response.Models) != 0 {
		t.Fatalf("final-size overflow was admitted: bytes=%d limited=%v rows=%d", limiter.modelBytes, limiter.limited, len(response.Models))
	}

	// One byte less than the final boundary is admitted and the complete response stays
	// within the outer response reserve instead of becoming a late 503.
	candidate.ID = candidate.ID[:len(candidate.ID)-2]
	response = adminModelsResponse{
		RequestID: "request", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Models: []adminModel{}, Providers: []adminModelProvider{}, PartialFailures: []adminModelPartialFailure{},
	}
	limiter = newAdminModelsResponseLimiter(providerRef)
	if !limiter.append(&response, candidate) {
		t.Fatal("final-size boundary model was rejected")
	}
	recorder := httptest.NewRecorder()
	writeAdminModelsResponse(recorder, response, providerRef)
	if recorder.Code != http.StatusOK || recorder.Body.Len() > maxAdminModelsResponseBytes {
		t.Fatalf("bounded final response status=%d bytes=%d", recorder.Code, recorder.Body.Len())
	}
}

func TestAdminModelCatalogCacheEnforcesTotalBounds(t *testing.T) {
	cache := newAdminModelCatalogCache()
	cache.maxEntries = 2
	cache.maxRows = 3
	cache.maxWeightBytes = 8 << 10
	baseTime := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	entry := func(id string, fetchedAt time.Time) adminModelCatalogCacheEntry {
		return adminModelCatalogCacheEntry{fingerprint: "fingerprint", models: []adminModelCatalogRow{{ID: id, Object: "model", OwnedBy: "owner"}}, fetchedAt: fetchedAt}
	}
	if !cache.put("oldest", entry("one", baseTime)) || !cache.put("newer", entry("two", baseTime.Add(time.Second))) || !cache.put("newest", entry("three", baseTime.Add(2*time.Second))) {
		t.Fatal("cache rejected entries within the configured total bounds")
	}
	if _, exists := cache.entries["oldest"]; exists {
		t.Fatal("cache did not evict the oldest entry at the entry bound")
	}
	if len(cache.entries) != 2 {
		t.Fatalf("cache entries = %d, want 2", len(cache.entries))
	}

	rowBounded := newAdminModelCatalogCache()
	rowBounded.maxRows = 1
	if rowBounded.put("too-many", adminModelCatalogCacheEntry{
		fingerprint: "fingerprint", models: []adminModelCatalogRow{{ID: "one"}, {ID: "two"}}, fetchedAt: baseTime,
	}) {
		t.Fatal("cache accepted a catalogue above the total row bound")
	}
	if len(rowBounded.entries) != 0 {
		t.Fatalf("row-bounded cache retained %d entries", len(rowBounded.entries))
	}

	weightBounded := newAdminModelCatalogCache()
	weightBounded.maxWeightBytes = 256
	if weightBounded.put("too-large", entry(strings.Repeat("x", 512), baseTime)) {
		t.Fatal("cache accepted a catalogue above the total weight bound")
	}
	if len(weightBounded.entries) != 0 {
		t.Fatalf("weight-bounded cache retained %d entries", len(weightBounded.entries))
	}
}

func TestAdminModelCatalogCacheEvictsEntriesBeyondStaleTTL(t *testing.T) {
	cache := newAdminModelCatalogCache()
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	cache.now = func() time.Time { return now }
	cache.freshTTL = time.Minute
	cache.staleTTL = 10 * time.Minute
	fallbackTimeout := 30 * time.Second
	provider := store.ProviderConfig{
		Name: "expired", BaseURL: "https://models.example", EncryptedAPIKey: "encrypted", Enabled: true,
	}
	fingerprint := adminModelProviderFingerprint(provider, fallbackTimeout)
	cache.entries[provider.Name] = adminModelCatalogCacheEntry{
		fingerprint: fingerprint,
		models:      []adminModelCatalogRow{{ID: "expired-model"}},
		fetchedAt:   now.Add(-cache.staleTTL - time.Second),
	}

	cache.prune([]store.ProviderConfig{provider}, fallbackTimeout)
	if _, exists := cache.entries[provider.Name]; exists {
		t.Fatal("prune retained a catalogue beyond the stale TTL")
	}

	cache.entries[provider.Name] = adminModelCatalogCacheEntry{
		fingerprint: fingerprint,
		models:      []adminModelCatalogRow{{ID: "expired-model"}},
		fetchedAt:   now.Add(-cache.staleTTL - time.Second),
	}
	if _, ok := cache.cached(provider, fallbackTimeout, true); ok {
		t.Fatal("stale lookup served a catalogue beyond the stale TTL")
	}
	if _, exists := cache.entries[provider.Name]; exists {
		t.Fatal("stale lookup retained an expired catalogue in memory")
	}
}

func TestNormalizedModelCreatedRejectsNonIntegralAndOverflowValues(t *testing.T) {
	if got := normalizedModelCreated(float64(123)); got == nil || *got != 123 {
		t.Fatalf("created = %v, want 123", got)
	}
	for _, value := range []any{nil, "123", float64(-1), float64(1.5), float64(9_223_372_036_854_775_808)} {
		if got := normalizedModelCreated(value); got != nil {
			t.Errorf("normalizedModelCreated(%v) = %d, want nil", value, *got)
		}
	}
}

func TestAdminModelsCoalescesRefreshesAndServesLastKnownGood(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		call := calls.Add(1)
		if call == 1 {
			close(started)
			<-release
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"id":"cached-model","owned_by":"catalog"}]}`)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "private upstream failure")
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "cached", BaseURL: upstream.URL, TimeoutMS: 2_000, Enabled: true,
	}, "cached-key")
	baseTime := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	var clock atomic.Int64
	clock.Store(baseTime.UnixNano())
	server.adminModels.now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	server.adminModels.freshTTL = time.Second
	server.adminModels.staleTTL = time.Minute

	type responseResult struct {
		status int
		body   adminModelsResponse
		err    error
	}
	const concurrentRequests = 8
	results := make(chan responseResult, concurrentRequests)
	startRequests := make(chan struct{})
	for range concurrentRequests {
		go func() {
			<-startRequests
			resp, err := http.Get(gateway.URL + "/admin/models")
			if err != nil {
				results <- responseResult{err: err}
				return
			}
			defer resp.Body.Close()
			var body adminModelsResponse
			err = json.NewDecoder(resp.Body).Decode(&body)
			results <- responseResult{status: resp.StatusCode, body: body, err: err}
		}()
	}
	close(startRequests)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("provider refresh did not start")
	}
	// Give the concurrent handlers time to join the in-flight refresh before it completes.
	time.Sleep(25 * time.Millisecond)
	close(release)
	for range concurrentRequests {
		result := <-results
		if result.err != nil || result.status != http.StatusOK {
			t.Fatalf("concurrent response status=%d err=%v", result.status, result.err)
		}
		if len(result.body.Models) != 1 || result.body.Models[0].ID != "cached-model" {
			t.Fatalf("concurrent response models = %+v", result.body.Models)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("concurrent requests made %d provider calls, want 1", got)
	}

	clock.Store(baseTime.Add(2 * time.Second).UnixNano())
	resp, body := getAdminModels(t, gateway.URL+"/admin/models", "")
	if resp.StatusCode != http.StatusOK || len(body.Models) != 1 {
		t.Fatalf("stale response status=%d body=%+v", resp.StatusCode, body)
	}
	if !body.Models[0].Stale || body.Models[0].Source != adminModelSourceCache {
		t.Fatalf("last-known-good model not marked stale cache: %+v", body.Models[0])
	}
	if len(body.Providers) != 1 || !body.Providers[0].Stale || body.Providers[0].Status != "ok" {
		t.Fatalf("last-known-good provider = %+v", body.Providers)
	}
	if len(body.PartialFailures) != 1 || body.PartialFailures[0].Code != "provider_models_unavailable" {
		t.Fatalf("stale refresh failure = %+v", body.PartialFailures)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private upstream failure") || strings.Contains(string(encoded), "cached-key") {
		t.Fatalf("stale response exposed provider details: %s", encoded)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("expired catalogue made %d provider calls, want 2", got)
	}
}

func TestAdminModelCatalogCacheBoundsGlobalProviderConcurrency(t *testing.T) {
	cache := newAdminModelCatalogCache()
	cache.semaphore = make(chan struct{}, 2)
	started := make(chan struct{}, 6)
	release := make(chan struct{})
	var active atomic.Int32
	var maximum atomic.Int32
	var wg sync.WaitGroup

	for index := range 6 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			provider := store.ProviderConfig{
				Name: "provider-" + strconv.Itoa(index), BaseURL: "https://models.example", Enabled: true,
			}
			result := cache.load(t.Context(), provider, time.Second, func(context.Context) ([]adminModelCatalogRow, error) {
				current := active.Add(1)
				for {
					observed := maximum.Load()
					if current <= observed || maximum.CompareAndSwap(observed, current) {
						break
					}
				}
				started <- struct{}{}
				<-release
				active.Add(-1)
				return []adminModelCatalogRow{{ID: "model"}}, nil
			})
			if result.status != "ok" {
				t.Errorf("provider %d result = %+v", index, result)
			}
		}(index)
	}

	for range 2 {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("bounded provider fetch did not start")
		}
	}
	select {
	case <-started:
		t.Fatal("more provider fetches started than the global semaphore permits")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	wg.Wait()
	if got := maximum.Load(); got != 2 {
		t.Fatalf("maximum provider concurrency = %d, want 2", got)
	}
}

func TestAdminModelCatalogCacheRechecksFreshEntryBeforeCreatingFlight(t *testing.T) {
	cache := newAdminModelCatalogCache()
	provider := store.ProviderConfig{
		Name: "atomic", BaseURL: "https://models.example", EncryptedAPIKey: "encrypted", Enabled: true,
	}
	pausedAfterMiss := make(chan struct{})
	resume := make(chan struct{})
	var resumeOnce sync.Once
	defer resumeOnce.Do(func() { close(resume) })
	var misses atomic.Int32
	cache.testAfterFreshMiss = func() {
		if misses.Add(1) == 1 {
			close(pausedAfterMiss)
			<-resume
		}
	}

	var fetches atomic.Int32
	fetch := func(context.Context) ([]adminModelCatalogRow, error) {
		fetches.Add(1)
		return []adminModelCatalogRow{{ID: "only-once"}}, nil
	}
	firstResult := make(chan adminProviderModelsResult, 1)
	go func() {
		firstResult <- cache.load(t.Context(), provider, time.Second, fetch)
	}()
	select {
	case <-pausedAfterMiss:
	case <-time.After(2 * time.Second):
		t.Fatal("first cache miss did not reach the race window")
	}

	second := cache.load(t.Context(), provider, time.Second, fetch)
	resumeOnce.Do(func() { close(resume) })
	var first adminProviderModelsResult
	select {
	case first = <-firstResult:
	case <-time.After(2 * time.Second):
		t.Fatal("paused cache load did not finish")
	}

	if got := fetches.Load(); got != 1 {
		t.Fatalf("race-window cache loads made %d fetches, want 1", got)
	}
	if second.status != "ok" || second.source != adminModelSourceLive {
		t.Fatalf("refresh leader result = %+v", second)
	}
	if first.status != "ok" || first.source != adminModelSourceCache || first.stale {
		t.Fatalf("resumed cache load did not use the fresh entry: %+v", first)
	}
}

func TestAdminModelsWorkerPoolConvergesAfterCancellation(t *testing.T) {
	const providerCount = 20
	started := make(chan struct{}, providerCount)
	exited := make(chan struct{}, providerCount)
	var calls atomic.Int32
	var active atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		active.Add(1)
		started <- struct{}{}
		<-r.Context().Done()
		active.Add(-1)
		exited <- struct{}{}
	}))
	defer upstream.Close()

	server, _, _ := newAdminModelsTestServer(t, "")
	server.adminModels.workerLimit = 2
	server.adminModels.semaphore = make(chan struct{}, providerCount)
	server.adminModels.refreshTimeout = 5 * time.Second
	encrypted, err := server.secrets.Load().Encrypt("worker-key")
	if err != nil {
		t.Fatal(err)
	}
	configs := make([]store.ProviderConfig, 0, providerCount)
	for index := range providerCount {
		configs = append(configs, store.ProviderConfig{
			Name: "worker-" + strconv.Itoa(index), BaseURL: upstream.URL,
			EncryptedAPIKey: encrypted, TimeoutMS: 5_000, Enabled: true,
		})
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	type fetchResult struct {
		models   []adminProviderModelsResult
		response adminModelsResponse
	}
	finished := make(chan fetchResult, 1)
	go func() {
		response := adminModelsResponse{}
		models := server.fetchAdminProviderModels(ctx, configs, "", "", server.providerRefsSnapshot().system, &response)
		finished <- fetchResult{models: models, response: response}
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("bounded model worker did not start")
		}
	}
	select {
	case <-started:
		t.Fatal("more provider requests started than the configured worker count")
	case <-time.After(25 * time.Millisecond):
	}

	cancel()
	var result fetchResult
	select {
	case result = <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("model workers did not converge after cancellation")
	}
	for range 2 {
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			t.Fatal("active upstream request did not observe cancellation")
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("provider calls after cancellation = %d, want 2", got)
	}
	if got := active.Load(); got != 0 {
		t.Fatalf("active provider calls after cancellation = %d, want 0", got)
	}
	if len(result.models) != providerCount || len(result.response.PartialFailures) != providerCount {
		t.Fatalf("cancelled result models=%d failures=%d, want %d each", len(result.models), len(result.response.PartialFailures), providerCount)
	}
}

func TestAdminModelsRefreshDeadlineCancelsSemaphoreWaitersAndServesStale(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"unexpected-live-model"}]}`)
	}))
	defer upstream.Close()

	server, _, _ := newAdminModelsTestServer(t, "")
	server.adminModels.workerLimit = 2
	server.adminModels.semaphore = make(chan struct{}, 1)
	server.adminModels.semaphore <- struct{}{}
	defer func() { <-server.adminModels.semaphore }()
	server.adminModels.refreshTimeout = 40 * time.Millisecond
	server.adminModels.freshTTL = time.Second
	server.adminModels.staleTTL = time.Minute
	now := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	server.adminModels.now = func() time.Time { return now }
	encrypted, err := server.secrets.Load().Encrypt("deadline-key")
	if err != nil {
		t.Fatal(err)
	}
	configs := []store.ProviderConfig{
		{Name: "deadline-a", BaseURL: upstream.URL, EncryptedAPIKey: encrypted, TimeoutMS: 5_000, Enabled: true},
		{Name: "deadline-b", BaseURL: upstream.URL, EncryptedAPIKey: encrypted, TimeoutMS: 5_000, Enabled: true},
	}
	fallbackTimeout := server.upstreamConf().Timeout
	for _, provider := range configs {
		server.adminModels.entries[provider.Name] = adminModelCatalogCacheEntry{
			fingerprint: adminModelProviderFingerprint(provider, fallbackTimeout),
			models:      []adminModelCatalogRow{{ID: provider.Name + "-cached"}},
			fetchedAt:   now.Add(-2 * time.Second),
		}
	}

	callerCtx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	response := adminModelsResponse{}
	startedAt := time.Now()
	results := server.fetchAdminProviderModels(callerCtx, configs, "", "", server.providerRefsSnapshot().system, &response)
	elapsed := time.Since(startedAt)
	if callerCtx.Err() != nil {
		t.Fatalf("caller deadline fired before the catalogue deadline: %v", callerCtx.Err())
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("catalogue deadline returned after %s, want under 500ms", elapsed)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("semaphore waiters reached the upstream %d times, want 0", got)
	}
	if len(results) != 2 || len(response.PartialFailures) != 2 {
		t.Fatalf("deadline results=%+v failures=%+v", results, response.PartialFailures)
	}
	for _, result := range results {
		if result.status != "ok" || !result.stale || result.source != adminModelSourceCache || result.failureCode != "provider_models_unavailable" {
			t.Fatalf("deadline did not return stale last-known-good data: %+v", result)
		}
	}
}
