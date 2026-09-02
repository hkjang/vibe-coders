package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

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
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4.1","object":"model"},{"id":"gpt-4.1-mini","object":"model"}]}`))
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
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"claude-opus-4-8","object":"model","owned_by":"anthropic"}]}`))
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
		{Name: "openai", BaseURL: oai.URL, EncryptedAPIKey: encKey, Enabled: true, ModelPatterns: "gpt-*"},
		{Name: "anthropic", BaseURL: anth.URL, EncryptedAPIKey: encKey, Enabled: true, ModelPatterns: "claude-*"},
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
	if _, err := server.fetchProviderModels(t.Context(), "oversized", upstream.URL, "secret", time.Second, ""); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized catalogue error = %v", err)
	}
}
