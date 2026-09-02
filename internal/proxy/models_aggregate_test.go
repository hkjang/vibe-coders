package proxy

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

type modelsRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn modelsRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func providerCatalogPayload(prefix string, count int) []byte {
	var payload strings.Builder
	payload.Grow(32 + count*(len(prefix)+24))
	payload.WriteString(`{"object":"list","data":[`)
	for index := range count {
		if index > 0 {
			payload.WriteByte(',')
		}
		payload.WriteString(`{"id":"`)
		payload.WriteString(prefix)
		payload.WriteString(strconv.Itoa(index))
		payload.WriteString(`","object":"model"}`)
	}
	payload.WriteString(`]}`)
	return []byte(payload.String())
}

func TestClientPinnedProviderRecognizesDocumentedQuery(t *testing.T) {
	unpinned := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	if clientPinnedProvider(unpinned) {
		t.Fatal("request without a provider selector must remain aggregated")
	}
	pinned := httptest.NewRequest(http.MethodGet, "/v1/models?provider=anthropic", nil)
	if !clientPinnedProvider(pinned) {
		t.Fatal("documented provider query must select the pinned-provider path")
	}
}

func TestPinnedModelsRetainsClassicQueryCompatibility(t *testing.T) {
	seen := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.URL.Path + "?" + r.URL.RawQuery + "|" + r.Header.Get("X-Vendor-Hint")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"pinned-model"}]}`)
	}))
	defer upstream.Close()
	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "pinned", BaseURL: upstream.URL + "/gateway?api-version=2026-01-01", TimeoutMS: 1_000, Enabled: true,
	}, "pinned-key")

	request, err := http.NewRequest(http.MethodGet, gateway.URL+"/v1/models?provider=pinned&vendor_hint=full", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Vendor-Hint", "classic")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pinned status = %d", response.StatusCode)
	}
	if got := <-seen; got != "/gateway/v1/models?api-version=2026-01-01&provider=pinned&vendor_hint=full|classic" {
		t.Fatalf("pinned upstream metadata = %q", got)
	}
}

// TestAggregatedModelsMergesAllProviders verifies that an unpinned GET /v1/models returns the
// union of every enabled provider's catalogue (tagged with its source), instead of only the
// default provider's list.
func TestAggregatedModelsMergesAllProviders(t *testing.T) {
	const callerSecret = "CALLER-MODELS-SECRET"
	assertNoCallerMetadata := func(t *testing.T, r *http.Request) {
		t.Helper()
		if r.URL.RawQuery != "" {
			t.Errorf("aggregate forwarded caller query %q", r.URL.RawQuery)
		}
		for _, header := range []string{"Cookie", "X-Api-Key", "X-Admin-Token", "X-Vendor-Auth"} {
			if value := r.Header.Get(header); value != "" {
				t.Errorf("aggregate forwarded %s=%q", header, value)
			}
		}
		if strings.Contains(r.Header.Get("Authorization"), callerSecret) {
			t.Errorf("aggregate forwarded caller authorization: %q", r.Header.Get("Authorization"))
		}
	}
	oai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		assertNoCallerMetadata(t, r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4.1","object":"model"},{"id":"gpt-4.1-mini","object":"model"},{"id":"shared-priority","object":"model"}]}`))
	}))
	defer oai.Close()
	anth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		assertNoCallerMetadata(t, r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"claude-opus-4-8","object":"model","owned_by":"anthropic"},{"id":"shared-priority","object":"model"}]}`))
	}))
	defer anth.Close()

	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig(oai.URL, "upstream-secret")
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	encKey, err := server.secrets.Load().Encrypt("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []store.ProviderConfig{
		{Name: "openai", BaseURL: oai.URL, EncryptedAPIKey: encKey, Enabled: true, ModelPatterns: "gpt-*", Priority: 10},
		{Name: "anthropic", BaseURL: anth.URL, EncryptedAPIKey: encKey, Enabled: true, ModelPatterns: "claude-*", Priority: 20},
		{Name: "disabled-one", BaseURL: anth.URL, EncryptedAPIKey: encKey, Enabled: false, ModelPatterns: "x-*"},
	} {
		if err := db.UpsertProvider(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertAgentRoute(ctx, store.AgentRoute{
		ID: "agent-shared", VirtualModel: "shared-priority", Name: "Shared route", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	oversizedRouteID := strings.Repeat("i", 513)
	if err := db.UpsertAgentRoute(ctx, store.AgentRoute{
		ID: oversizedRouteID, VirtualModel: "id-only-route", Name: "Oversized descriptive ID", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	request, err := http.NewRequest(http.MethodGet, proxy.URL+"/v1/models?vendor_hint=full&api_key="+callerSecret, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+callerSecret)
	request.Header.Set("Cookie", "session="+callerSecret)
	request.Header.Set("X-Api-Key", callerSecret)
	request.Header.Set("X-Admin-Token", callerSecret)
	request.Header.Set("X-Vendor-Auth", callerSecret)
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var parsed struct {
		Object string           `json:"object"`
		Data   []map[string]any `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Object != "list" {
		t.Fatalf("object = %q, want list", parsed.Object)
	}

	byID := map[string]map[string]any{}
	for _, m := range parsed.Data {
		id, _ := m["id"].(string)
		byID[id] = m
	}
	for _, want := range []string{"gpt-4.1", "gpt-4.1-mini", "claude-opus-4-8", "id-only-route"} {
		if _, ok := byID[want]; !ok {
			t.Fatalf("expected model %q in aggregated list, got %v", want, keysOfAny(byID))
		}
	}
	if hdr := resp.Header.Get("X-Models-Providers"); hdr == "" {
		t.Fatal("expected X-Models-Providers header")
	}
	if got := resp.Header.Get("X-Models-Truncated"); got != "" {
		t.Fatalf("oversized descriptive route ID marked the complete model projection truncated: %q", got)
	}
	// Every merged model is tagged with a source provider, and the provider name fills in
	// owned_by when the upstream omits it.
	if got, _ := byID["gpt-4.1"]["provider"].(string); got == "" {
		t.Fatalf("gpt-4.1 must carry a provider tag, got %v", byID["gpt-4.1"])
	}
	if got, _ := byID["gpt-4.1"]["owned_by"].(string); got == "" {
		t.Fatalf("gpt-4.1 owned_by should be filled from provider, got %v", byID["gpt-4.1"])
	}
	// anthropic is the only provider serving claude, so its tag/owned_by are deterministic.
	if got := byID["claude-opus-4-8"]["provider"]; got != "anthropic" {
		t.Fatalf("claude provider tag = %v, want anthropic", got)
	}
	if got := byID["claude-opus-4-8"]["owned_by"]; got != "anthropic" {
		t.Fatalf("claude owned_by (preserved) = %v, want anthropic", got)
	}
	sharedCount := 0
	for _, model := range parsed.Data {
		if model["id"] == "shared-priority" {
			sharedCount++
		}
	}
	if got := byID["shared-priority"]["provider"]; got != "vibe" || byID["shared-priority"]["agent_route"] != true || sharedCount != 1 {
		t.Fatalf("agent route must deterministically shadow the physical duplicate once: count=%d model=%v", sharedCount, byID["shared-priority"])
	}
	if got := byID["id-only-route"]["provider"]; got != "vibe" || byID["id-only-route"]["agent_route"] != true {
		t.Fatalf("oversized route ID lost its complete virtual key: %v", byID["id-only-route"])
	}
	encoded, _ := json.Marshal(parsed)
	if strings.Contains(string(encoded), oversizedRouteID) {
		t.Fatalf("oversized descriptive route ID escaped through public models: %s", encoded)
	}
}

func keysOfAny(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestFetchProviderModelsRejectsOversizedCatalog(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"` + strings.Repeat("x", maxModelsResponseBytes) + `"}]}`))
	}))
	defer upstream.Close()

	server := &Server{client: upstream.Client()}
	if _, err := server.fetchProviderModels(t.Context(), "oversized", upstream.URL, "secret", time.Second); err == nil || !strings.Contains(err.Error(), "exceeds") || providerModelsFailureCode(err) != "provider_models_limit_exceeded" {
		t.Fatalf("oversized catalogue error = %v", err)
	}
}

func TestDecodeProviderModelsEnforcesRowLimitWhileDecoding(t *testing.T) {
	models, err := decodeProviderModels(providerCatalogPayload("model-", maxModelsPerProvider))
	if err != nil {
		t.Fatalf("catalogue at row limit failed: %v", err)
	}
	if len(models) != maxModelsPerProvider {
		t.Fatalf("decoded rows = %d, want %d", len(models), maxModelsPerProvider)
	}

	_, err = decodeProviderModels(providerCatalogPayload("model-", maxModelsPerProvider+1))
	if err == nil || !isProviderModelsLimitError(err) {
		t.Fatalf("catalogue above row limit error = %v, want typed limit error", err)
	}
	if code := providerModelsFailureCode(err); code != "provider_models_limit_exceeded" {
		t.Fatalf("limit failure code = %q", code)
	}
}

func TestAggregatedModelsResultCapsRowsAndEncodedResponse(t *testing.T) {
	result := aggregatedModelsResult{data: []map[string]any{}}
	for index := range maxAggregatedModels + 1 {
		appended := appendBoundedAggregatedModel(&result, map[string]any{
			"id": "model-" + strconv.Itoa(index), "object": "model", "provider": "provider",
		})
		if index < maxAggregatedModels && !appended {
			t.Fatalf("row %d was rejected before the aggregate row limit", index)
		}
		if index == maxAggregatedModels && appended {
			t.Fatal("aggregate accepted a row beyond the row limit")
		}
	}
	encoded, err := json.Marshal(map[string]any{"object": "list", "data": result.data})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.data) != maxAggregatedModels || len(encoded) > maxAggregatedModelsResponseBytes {
		t.Fatalf("aggregate rows=%d encoded=%d, limits rows=%d encoded=%d", len(result.data), len(encoded), maxAggregatedModels, maxAggregatedModelsResponseBytes)
	}
	result = aggregatedModelsResult{data: []map[string]any{}, payloadBytes: maxAggregatedModelsPayloadBytes - 8}
	if appendBoundedAggregatedModel(&result, map[string]any{"id": "does-not-fit"}) {
		t.Fatal("aggregate accepted a model beyond the encoded payload budget")
	}
}

func TestUnpinnedModelsBoundsProviderFanoutAndKeepsPinnedPassthrough(t *testing.T) {
	var calls atomic.Int32
	var active atomic.Int32
	var maximum atomic.Int32
	started := make(chan struct{}, modelsCatalogMaxConcurrency)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		call := calls.Add(1)
		current := active.Add(1)
		defer active.Add(-1)
		for {
			observed := maximum.Load()
			if current <= observed || maximum.CompareAndSwap(observed, current) {
				break
			}
		}
		if call <= modelsCatalogMaxConcurrency {
			started <- struct{}{}
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"shared-model"}]}`))
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	for index := range maxModelsProvidersPerRequest + 6 {
		addAdminModelsProvider(t, server, db, store.ProviderConfig{
			Name: "provider-" + fmtProviderIndex(index), BaseURL: upstream.URL, TimeoutMS: 2_000,
			Enabled: true, Priority: index + 1,
		}, "catalog-key")
	}

	responseReady := make(chan *http.Response, 1)
	requestError := make(chan error, 1)
	go func() {
		response, err := http.Get(gateway.URL + "/v1/models")
		if err != nil {
			requestError <- err
			return
		}
		responseReady <- response
	}()
	for range modelsCatalogMaxConcurrency {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("bounded public model fanout did not start")
		}
	}
	select {
	case <-started:
		t.Fatal("public model fanout exceeded the fixed worker count")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)

	var response *http.Response
	select {
	case err := <-requestError:
		t.Fatal(err)
	case response = <-responseReady:
	case <-time.After(5 * time.Second):
		t.Fatal("bounded public model request did not finish")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unbounded response status = %d", response.StatusCode)
	}
	if got := calls.Load(); got != maxModelsProvidersPerRequest {
		t.Fatalf("provider calls = %d, want %d", got, maxModelsProvidersPerRequest)
	}
	if got := maximum.Load(); got > modelsCatalogMaxConcurrency {
		t.Fatalf("maximum provider concurrency = %d, cap %d", got, modelsCatalogMaxConcurrency)
	}
	if got := response.Header.Get("X-Models-Providers-Skipped"); got != "1" {
		t.Fatalf("skipped provider header = %q, want an overflow signal", got)
	}
	if got := response.Header.Get("X-Models-Truncated"); got != "true" {
		t.Fatalf("truncated header = %q, want true", got)
	}
	if got := len(strings.Split(response.Header.Get("X-Models-Providers"), ",")); got != maxModelsProvidersPerRequest {
		t.Fatalf("successful provider header count = %d, want %d", got, maxModelsProvidersPerRequest)
	}

	pinned, err := http.Get(gateway.URL + "/v1/models?provider=provider-069")
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Body.Close()
	if pinned.StatusCode != http.StatusOK {
		t.Fatalf("pinned response status = %d", pinned.StatusCode)
	}
	if got := calls.Load(); got != maxModelsProvidersPerRequest+1 {
		t.Fatalf("pinned request made aggregate calls: total calls = %d", got)
	}
	if pinned.Header.Get("X-Models-Truncated") != "" || pinned.Header.Get("X-Models-Providers") != "" {
		t.Fatalf("pinned response carried aggregate headers: %v", pinned.Header)
	}
}

func fmtProviderIndex(index int) string {
	formatted := strconv.Itoa(index)
	return strings.Repeat("0", 3-len(formatted)) + formatted
}

func TestUnpinnedModelsClassicFallbackSharesAggregateDeadline(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-r.Context().Done()
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	server.adminModels.refreshTimeout = 50 * time.Millisecond
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "deadline", BaseURL: upstream.URL, TimeoutMS: 5_000, Enabled: true,
	}, "catalog-key")

	startedAt := time.Now()
	response, err := http.Get(gateway.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if elapsed := time.Since(startedAt); elapsed > 500*time.Millisecond {
		t.Fatalf("all-provider fallback exceeded shared deadline: %s", elapsed)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("classic fallback started %d upstream calls after aggregate timeout, want 1 total", got)
	}
	if response.StatusCode != http.StatusGatewayTimeout {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("deadline status = %d, want 504: %s", response.StatusCode, body)
	}
	if got := response.Header.Get("X-Models-Providers-Failed"); got != "deadline" {
		t.Fatalf("failed provider header = %q, want deadline", got)
	}
}

func TestDecodeProviderModelsAcceptsCaseInsensitiveDataKey(t *testing.T) {
	for _, key := range []string{"data", "Data", "DATA"} {
		t.Run(key, func(t *testing.T) {
			models, err := decodeProviderModels([]byte(`{"` + key + `":[{"id":"legacy"}]}`))
			if err != nil || len(models) != 1 || models[0]["id"] != "legacy" {
				t.Fatalf("decoded models = %#v err=%v", models, err)
			}
		})
	}
}

func TestUnpinnedModelsFallbackValidatesGzipBeforeCommit(t *testing.T) {
	var calls atomic.Int32
	upstreamSecret := "UPSTREAM-HEADER-MUST-NOT-LEAK"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		call := calls.Add(1)
		w.Header().Set("X-Upstream-Secret", upstreamSecret)
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			// The aggregate attempt exceeds the provider row cap.
			_, _ = w.Write(providerCatalogPayload("aggregate-", maxModelsPerProvider+1))
			return
		}
		// The classic compatibility attempt is small on the wire but exceeds the
		// byte cap after decompression. No header/body is committed before validation.
		w.Header().Set("Content-Encoding", "gzip")
		zipper := gzip.NewWriter(w)
		_, _ = zipper.Write([]byte(`{"data":[{"id":"` + strings.Repeat("z", maxModelsResponseBytes) + `"}]}`))
		_ = zipper.Close()
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	server.cfg.Upstream.Provider = "fallback"
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "fallback", BaseURL: upstream.URL, TimeoutMS: 5_000, Enabled: true,
	}, "catalog-key")

	request, err := http.NewRequest(http.MethodGet, gateway.URL+"/v1/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if calls.Load() != 2 {
		t.Fatalf("upstream calls = %d, want aggregate plus bounded fallback", calls.Load())
	}
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "provider_models_limit_exceeded") {
		t.Fatalf("fallback response = %d %s", response.StatusCode, body)
	}
	if response.Header.Get("X-Models-Truncated") != "true" {
		t.Fatalf("missing truncation header: %v", response.Header)
	}
	if response.Header.Get("X-Upstream-Secret") != "" || response.Header.Get("Content-Encoding") != "" || bytes.Contains(body, []byte(upstreamSecret)) || len(body) > 4<<10 {
		t.Fatalf("unvalidated upstream response leaked: headers=%v body_bytes=%d", response.Header, len(body))
	}
}

func TestUnpinnedModelsFallbackUsesStrictRequestAndResponseHeaders(t *testing.T) {
	const callerSecret = "CALLER-FALLBACK-SECRET"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		if r.URL.RawQuery != "api-version=2026-01-01&region=koreacentral" {
			t.Errorf("models request query = %q, want only provider fixed query", r.URL.RawQuery)
		}
		for _, header := range []string{"Cookie", "X-Api-Key", "X-Admin-Token", "X-Vendor-Auth"} {
			if value := r.Header.Get(header); value != "" {
				t.Errorf("fallback path forwarded %s=%q", header, value)
			}
		}
		if strings.Contains(r.Header.Get("Authorization"), callerSecret) {
			t.Errorf("fallback path forwarded caller authorization: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			_, _ = io.WriteString(w, `{"data":"aggregate failure"}`)
			return
		}
		w.Header().Set("Set-Cookie", "session="+callerSecret)
		w.Header().Set("Location", "https://redirect.invalid/?token="+callerSecret)
		w.Header().Set("Authorization", "Bearer "+callerSecret)
		w.Header().Set("X-Diagnostic-Secret", callerSecret)
		_, _ = io.WriteString(w, `{"data":[{"id":"fallback-model"}]}`)
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	server.cfg.Upstream.Provider = "fallback"
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "fallback", BaseURL: upstream.URL + "?api-version=2026-01-01&region=koreacentral", TimeoutMS: 5_000, Enabled: true,
	}, "catalog-key")
	request, err := http.NewRequest(http.MethodGet, gateway.URL+"/v1/models?vendor_hint=full&api_key="+callerSecret, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+callerSecret)
	request.Header.Set("Cookie", "session="+callerSecret)
	request.Header.Set("X-Api-Key", callerSecret)
	request.Header.Set("X-Admin-Token", callerSecret)
	request.Header.Set("X-Vendor-Auth", callerSecret)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "fallback-model") || calls.Load() != 2 {
		t.Fatalf("bounded fallback response = %d calls=%d body=%s", response.StatusCode, calls.Load(), body)
	}
	for _, header := range []string{"Set-Cookie", "Location", "Authorization", "X-Diagnostic-Secret"} {
		if value := response.Header.Get(header); value != "" {
			t.Fatalf("fallback response forwarded %s=%q", header, value)
		}
	}
	if strings.Contains(fmt.Sprint(response.Header)+string(body), callerSecret) {
		t.Fatalf("fallback response reflected caller secret: headers=%v body=%s", response.Header, body)
	}
}

func TestUnpinnedModelsFallbackSharesGlobalConcurrencyCap(t *testing.T) {
	const requestCount = modelsCatalogMaxConcurrency * 2
	var active, maximum atomic.Int32
	started := make(chan struct{}, requestCount)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("X-Request-ID") == "" {
			_, _ = io.WriteString(w, `{"data":"aggregate failure"}`)
			return
		}
		current := active.Add(1)
		defer active.Add(-1)
		for {
			previous := maximum.Load()
			if current <= previous || maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		started <- struct{}{}
		<-release
		_, _ = io.WriteString(w, `{"data":[{"id":"fallback-model"}]}`)
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	server.cfg.Upstream.Provider = "fallback"
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "fallback", BaseURL: upstream.URL, TimeoutMS: 5_000, Enabled: true,
	}, "catalog-key")

	responses := make(chan error, requestCount)
	for range requestCount {
		go func() {
			response, err := http.Get(gateway.URL + "/v1/models")
			if err != nil {
				responses <- err
				return
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, response.Body)
			if response.StatusCode != http.StatusOK {
				responses <- fmt.Errorf("fallback status %d", response.StatusCode)
				return
			}
			responses <- nil
		}()
	}
	for range modelsCatalogMaxConcurrency {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("fallback did not fill the shared concurrency cap")
		}
	}
	select {
	case <-started:
		t.Fatal("fallback exceeded the shared global concurrency cap")
	case <-time.After(50 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	for range requestCount {
		if err := <-responses; err != nil {
			t.Fatal(err)
		}
	}
	if maximum.Load() > modelsCatalogMaxConcurrency {
		t.Fatalf("maximum fallback concurrency = %d, cap %d", maximum.Load(), modelsCatalogMaxConcurrency)
	}
}

func TestUnpinnedModelsTransportErrorNeverReflectsURLOrCredentials(t *testing.T) {
	const querySecret = "URL_QUERY_SECRET_VALUE"
	const providerSecret = "sk-ant-provider-secret-value"
	server, db, gateway := newAdminModelsTestServer(t, "")
	server.cfg.Upstream.Provider = "fallback"
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "fallback", BaseURL: "https://provider.invalid", TimeoutMS: 5_000, Enabled: true,
	}, providerSecret)

	server.client = &http.Client{Transport: modelsRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("dial %s authorization=%s", request.URL.String(), request.Header.Get("Authorization"))
	})}
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)

	response, err := http.Get(gateway.URL + "/v1/models?api_key=" + querySecret)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "models_fallback_upstream_unavailable") {
		t.Fatalf("transport failure response = %d %s", response.StatusCode, body)
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent request = %#v err=%v", recent, err)
	}
	detail, err := db.RequestDetail(context.Background(), recent[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	auditJSON, _ := json.Marshal(detail.Request)
	reflected := string(body) + fmt.Sprint(response.Header) + logs.String() + string(auditJSON)
	for _, secret := range []string{querySecret, providerSecret, "Bearer " + providerSecret, "provider.invalid"} {
		if strings.Contains(reflected, secret) {
			t.Fatalf("fallback error reflected %q: %s", secret, reflected)
		}
	}
	if detail.Request.Error != "models_fallback_upstream_unavailable" || detail.Request.FallbackReason != "models_fallback_upstream_unavailable" || detail.Request.RouteReason != "models_fallback" {
		t.Fatalf("audit error fields are not stable codes: %+v", detail.Request)
	}
}

func TestAggregatedModelsBoundsLegacyProviderLabelsInBodyHeadersAndAudit(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"legacy-model"}]}`)
	}))
	defer upstream.Close()

	server, db, gateway := newAdminModelsTestServer(t, "")
	unsafeName := "legacy,\r\nX-Injected: sk-ant-provider-secret-value"
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: unsafeName, BaseURL: upstream.URL, TimeoutMS: 5_000, Enabled: true,
	}, "catalog-key")

	response, err := http.Get(gateway.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("legacy provider response = %d %s", response.StatusCode, body)
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Data) != 1 {
		t.Fatalf("legacy provider payload = %#v err=%v", payload, err)
	}
	if payload.Data[0]["provider"] != "[provider-name-omitted]" || payload.Data[0]["owned_by"] != "[provider-name-omitted]" {
		t.Fatalf("legacy provider body label was not bounded: %v", payload.Data[0])
	}
	waitFor(t, time.Second, func() bool { return server.logger.Written() >= 1 })
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent request = %#v err=%v", recent, err)
	}
	detail, err := db.RequestDetail(context.Background(), recent[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	reflected := string(body) + fmt.Sprint(response.Header) + detail.Request.RouteDetail + detail.Request.Provider
	for _, secret := range []string{"X-Injected", "sk-ant-provider-secret-value", unsafeName} {
		if strings.Contains(reflected, secret) {
			t.Fatalf("legacy provider metadata reflected %q: %s", secret, reflected)
		}
	}
	if response.Header.Get("X-Models-Metadata-Omitted") != "1" || response.Header.Get("X-Models-Truncated") != "true" || len(detail.Request.RouteDetail) > maxModelsAuditDetailBytes {
		t.Fatalf("bounded metadata observability missing: headers=%v audit=%q", response.Header, detail.Request.RouteDetail)
	}
}

func TestAggregatedModelsAgentRouteLookupFailureIsSanitizedAndTruncated(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "agent-route-failure.db")
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

	response, err := http.Get(gateway.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "physical-model") {
		t.Fatalf("physical catalogue was lost after route lookup failure: %d %s", response.StatusCode, body)
	}
	if response.Header.Get("X-Models-Providers-Failed") != "vibe" || response.Header.Get("X-Models-Truncated") != "true" {
		t.Fatalf("route lookup failure observability missing: %v", response.Header)
	}
	if strings.Contains(strings.ToLower(string(body)+fmt.Sprint(response.Header)), "no such table") {
		t.Fatalf("database error leaked to public response: headers=%v body=%s", response.Header, body)
	}
}

func TestModelsMetadataAndAuditBudgetsAreDeterministic(t *testing.T) {
	result := aggregatedModelsResult{}
	for index := range maxModelsProvidersPerRequest {
		result.providersOK = append(result.providersOK, fmt.Sprintf("provider-%03d-%s", index, strings.Repeat("p", 220)))
	}
	result.providersErr = []string{
		"line\r\nbreak", "comma,name", "sk-ant-provider-secret-value", strings.Repeat("x", maxModelsProviderNameBytes+1),
	}
	boundAggregatedModelsMetadata(&result)
	response := httptest.NewRecorder()
	setAggregatedModelsHeaders(response, result)
	combinedHeaders := response.Header().Get("X-Models-Providers") + response.Header().Get("X-Models-Providers-Failed")
	if len(combinedHeaders) > maxModelsMetadataHeaderBytes || strings.ContainsAny(combinedHeaders, "\r\n") || strings.Contains(combinedHeaders, "sk-ant-provider-secret-value") {
		t.Fatalf("provider metadata header exceeded safety contract: %q", combinedHeaders)
	}
	if !result.truncated || result.metadataOmitted == 0 || response.Header().Get("X-Models-Metadata-Omitted") == "" {
		t.Fatalf("metadata omissions were not signalled: result=%+v headers=%v", result, response.Header())
	}
	if detail := aggregatedModelsAuditDetail(result); len(detail) > maxModelsAuditDetailBytes || strings.Contains(detail, "sk-ant-provider-secret-value") {
		t.Fatalf("audit detail exceeded safety contract: %q", detail)
	}
}

func TestModelsFallbackAuthPolicyUsesRawNameButAuditsBoundedLabel(t *testing.T) {
	server, db, _ := newAdminModelsTestServer(t, "")
	unsafeName := "sk-ant-provider-secret-value"
	server.cfg.Upstream.Provider = unsafeName
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: unsafeName, BaseURL: "https://provider.invalid", TimeoutMS: 1_000, Enabled: true,
	}, "catalog-key")

	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	response := httptest.NewRecorder()
	traceID := "trace-models-auth-policy"
	meta := server.auditRequest(request.URL.Path, nil, "anonymous", traceID, request)
	pipeline := requestPipeline{
		s: server, w: response, r: request, traceID: traceID, meta: meta,
		modelsAggregateFallback: true,
		authCtx:                 &store.AuthContext{APIKeyID: "policy-key", TeamID: "security", DeniedProviders: []string{unsafeName}},
	}
	if pipeline.stepUpstream() {
		t.Fatal("denied fallback provider unexpectedly continued")
	}
	if response.Code != http.StatusForbidden {
		t.Fatalf("denied fallback status = %d", response.Code)
	}
	events, err := db.ListAuditEvents(t.Context(), 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("auth events = %#v err=%v", events, err)
	}
	if events[0].Detail != "provider:[provider-name-omitted]" || strings.Contains(events[0].Detail, unsafeName) {
		t.Fatalf("auth policy audit leaked provider name: %+v", events[0])
	}
}

func TestModelsFallbackBreakerObservabilityBoundsLegacyProviderName(t *testing.T) {
	const unsafeName = "sk-ant-provider-secret-value"
	received := make(chan string, 4)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(body, &payload)
		received <- payload.Text
		w.WriteHeader(http.StatusOK)
	}))
	defer hook.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":"unavailable"}`)
	}))
	defer upstream.Close()

	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "breaker-models.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig(upstream.URL, "default-key")
	cfg.Upstream.Provider = unsafeName
	cfg.Upstream.BreakerEnabled = true
	cfg.Upstream.BreakerThreshold = 1
	cfg.Upstream.BreakerCooldown = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: unsafeName, BaseURL: upstream.URL, TimeoutMS: 1_000, Enabled: true,
	}, "catalog-key")
	for key, value := range map[string]string{
		"mattermost_enabled": "true", "mattermost_webhook_url": hook.URL, "mattermost_events": "provider",
	} {
		if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: key, Value: value, UpdatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	server.invalidateMattermostCache()
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()

	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)
	response, err := http.Get(gateway.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("breaker fallback response = %d %s", response.StatusCode, body)
	}

	messages := []string{}
	deadline := time.After(2 * time.Second)
	for len(messages) < 2 {
		select {
		case message := <-received:
			messages = append(messages, message)
		case <-deadline:
			if len(messages) == 0 {
				t.Fatal("expected bounded breaker/fallback notification")
			}
			goto checked
		}
	}

checked:
	observed := logs.String() + strings.Join(messages, "\n") + string(body) + fmt.Sprint(response.Header)
	if strings.Contains(observed, unsafeName) {
		t.Fatalf("breaker observability leaked legacy provider name: %s", observed)
	}
	if !strings.Contains(observed, "[provider-name-omitted]") {
		t.Fatalf("breaker observability omitted the safe label: %s", observed)
	}
	snapshots := server.breakers.snapshot(time.Hour, time.Now())
	if len(snapshots) != 1 || snapshots[0].Provider != "[provider-name-omitted]" {
		t.Fatalf("breaker snapshot leaked legacy provider name: %+v", snapshots)
	}
}

func TestAgentRouteShadowDoesNotRetainPhysicalModelWhenReplacementCannotFit(t *testing.T) {
	const routeModelMaxBytes = 512
	virtualID := strings.Repeat("v", routeModelMaxBytes)
	physical := map[string]any{"id": virtualID}
	route := map[string]any{
		"id": virtualID, "object": "model", "owned_by": "agent-route", "provider": "vibe", "agent_route": true,
	}
	physicalJSON, _ := json.Marshal(physical)
	routeJSON, _ := json.Marshal(route)
	delta := len(routeJSON) - len(physicalJSON)
	if delta <= 0 {
		t.Fatal("test requires the virtual replacement to be larger")
	}
	baseFiller, _ := json.Marshal(map[string]any{"id": "filler", "payload": ""})
	fillerLength := maxAggregatedModelsPayloadBytes - (len(physicalJSON) + 1) - (len(baseFiller) + 1) - delta + 1
	if fillerLength <= 0 {
		t.Fatal("invalid test filler length")
	}
	result := aggregatedModelsResult{data: []map[string]any{
		{"id": "filler", "payload": strings.Repeat("x", fillerLength)},
		physical,
	}}
	mergeAgentRouteModels(&result, []store.AgentRouteModel{{ID: "route", VirtualModel: virtualID}}, false)
	for _, model := range result.data {
		if model["id"] == virtualID {
			t.Fatalf("physical shadow survived a replacement bound failure: %v", model)
		}
	}
	if !result.truncated {
		t.Fatal("replacement omission was not marked truncated")
	}
}

func TestAgentRouteProjectionUncertaintyOmitsUnknownPhysicalModels(t *testing.T) {
	result := aggregatedModelsResult{data: []map[string]any{{"id": "possibly-shadowed", "provider": "physical"}}}
	mergeAgentRouteModels(&result, []store.AgentRouteModel{{ID: "known", VirtualModel: "known-route"}}, true)
	if len(result.data) != 1 || result.data[0]["id"] != "known-route" || result.data[0]["agent_route"] != true {
		t.Fatalf("overflow projection retained unknown physical models: %v", result.data)
	}
}
