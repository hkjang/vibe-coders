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

	"vibe-coders/internal/store"
)

func TestOpenAPISwaggerAndVersion(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	// openapi.json: valid JSON carrying the gateway version.
	resp, err := http.Get(srv.URL + "/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/openapi.json = %d", resp.StatusCode)
	}
	var spec map[string]any
	if err := json.Unmarshal(body, &spec); err != nil {
		t.Fatalf("openapi.json is not valid JSON: %v", err)
	}
	info, _ := spec["info"].(map[string]any)
	if info["version"] != AppVersion {
		t.Errorf("openapi version = %v, want %s", info["version"], AppVersion)
	}
	if _, ok := spec["paths"].(map[string]any)["/v1/chat/completions"]; !ok {
		t.Error("openapi.json missing /v1/chat/completions path")
	}

	// swagger page renders and points at the spec.
	sw, err := http.Get(srv.URL + "/swagger")
	if err != nil {
		t.Fatal(err)
	}
	swBody, _ := io.ReadAll(sw.Body)
	sw.Body.Close()
	if sw.StatusCode != http.StatusOK || !strings.Contains(string(swBody), "/openapi.json") {
		t.Fatalf("/swagger should render and reference /openapi.json (status %d)", sw.StatusCode)
	}

	// /auth/me exposes the version (legacy/no-auth mode in testConfig).
	me, err := http.Get(srv.URL + "/auth/me")
	if err != nil {
		t.Fatal(err)
	}
	var meBody map[string]any
	json.NewDecoder(me.Body).Decode(&meBody)
	me.Body.Close()
	if meBody["version"] != AppVersion {
		t.Errorf("/auth/me version = %v, want %s", meBody["version"], AppVersion)
	}
}
