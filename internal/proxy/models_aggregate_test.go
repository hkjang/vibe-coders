package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

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

// TestAggregatedModelsMergesAllProviders verifies that an unpinned GET /v1/models returns the
// union of every enabled provider's catalogue (tagged with its source), instead of only the
// default provider's list.
func TestAggregatedModelsMergesAllProviders(t *testing.T) {
	oai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.RawQuery != "vendor_hint=full" {
			t.Errorf("openai model query = %q, want public query preserved", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4.1","object":"model"},{"id":"gpt-4.1-mini","object":"model"},{"id":"shared-priority","object":"model"}]}`))
	}))
	defer oai.Close()
	anth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.RawQuery != "vendor_hint=full" {
			t.Errorf("anthropic model query = %q, want public query preserved", r.URL.RawQuery)
		}
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

	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/v1/models?vendor_hint=full")
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
	for _, want := range []string{"gpt-4.1", "gpt-4.1-mini", "claude-opus-4-8"} {
		if _, ok := byID[want]; !ok {
			t.Fatalf("expected model %q in aggregated list, got %v", want, keysOfAny(byID))
		}
	}
	if hdr := resp.Header.Get("X-Models-Providers"); hdr == "" {
		t.Fatal("expected X-Models-Providers header")
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
	if got := byID["shared-priority"]["provider"]; got != "openai" {
		t.Fatalf("duplicate model provider = %v, want first priority provider openai", got)
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
	if _, err := server.fetchProviderModels(t.Context(), "oversized", upstream.URL, "secret", time.Second, ""); err == nil || !strings.Contains(err.Error(), "exceeds") || providerModelsFailureCode(err) != "provider_models_limit_exceeded" {
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
	if got := response.Header.Get("X-Models-Providers-Skipped"); got != "6" {
		t.Fatalf("skipped provider header = %q, want 6", got)
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
	if got := response.Header.Get("X-Models-Providers-Failed"); got != "deadline" {
		t.Fatalf("failed provider header = %q, want deadline", got)
	}
}
