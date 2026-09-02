package proxy

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestChatCompletionStreamingProxyAndAsyncAudit(t *testing.T) {
	authSeen := make(chan string, 1)
	firstChunkSent := make(chan struct{})
	allowSecondChunk := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen <- r.Header.Get("Authorization")
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		time.Sleep(20 * time.Millisecond)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		flusher.Flush()
		close(firstChunkSent)
		<-allowSecondChunk
		_, _ = w.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := config.Config{
		ListenAddr: ":0",
		Upstream: config.UpstreamConfig{
			Provider: "test",
			BaseURL:  upstream.URL,
			APIKey:   "upstream-secret",
			Timeout:  5 * time.Second,
		},
		Database: config.DatabaseConfig{Driver: "sqlite"},
		Logging: config.LoggingConfig{
			ResponseText:     true,
			ResponseMaxBytes: 4096,
			QueueSize:        32,
		},
		Pricing: map[string]config.ModelPrice{
			"test-model": {InputKRWPer1M: 1, OutputKRWPer1M: 2},
		},
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	bodyBytes, err := json.Marshal(map[string]any{
		"model":  "test-model",
		"stream": true,
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": "Please edit main.go\n```go\nfunc main() {}\n```",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer proxy-secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.10")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	select {
	case <-firstChunkSent:
	case <-time.After(time.Second):
		t.Fatal("upstream did not send first chunk")
	}

	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "hello") {
		t.Fatalf("expected first chunk before upstream completed, got %q", line)
	}
	close(allowSecondChunk)
	rest, err := reader.ReadString(0)
	if err == nil {
		t.Fatalf("expected EOF from ReadString delimiter 0, got rest %q", rest)
	}

	if got := <-authSeen; got != "Bearer upstream-secret" {
		t.Fatalf("expected upstream auth key, got %q", got)
	}

	waitFor(t, time.Second, func() bool {
		stats, err := db.Summary(context.Background())
		return err == nil && stats.TotalRequests == 1 && stats.TotalTokens == 10 && len(stats.ByLanguage) == 1
	})

	stats, err := db.Summary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.ByIP[0].Key != "203.0.113.10" {
		t.Fatalf("unexpected ip stats: %#v", stats.ByIP)
	}
	if stats.ByLanguage[0].Language != "Go" {
		t.Fatalf("unexpected language stats: %#v", stats.ByLanguage)
	}
	if stats.TotalCostKRW <= 0 {
		encoded, _ := json.Marshal(stats)
		t.Fatalf("expected cost to be calculated, got %s", encoded)
	}
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 {
		t.Fatalf("expected one recent request, got %d", len(recent))
	}
	if recent[0].FirstChunkMS <= 0 {
		t.Fatalf("expected first_chunk_ms to be tracked, got %#v", recent[0])
	}
	if recent[0].LatencyMS < recent[0].FirstChunkMS {
		t.Fatalf("expected latency_ms >= first_chunk_ms, got latency=%d first_chunk=%d", recent[0].LatencyMS, recent[0].FirstChunkMS)
	}
}

func TestAdminAPIKeyCreationEnforcesProxyAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{
		"name":  "Roo Code",
		"key":   "proxy-secret",
		"owner": "alice",
		"team":  "platform",
	})
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected key creation status 201, got %d", createResp.StatusCode)
	}

	noAuth := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if noAuth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected unauthenticated request to fail after key creation, got %d", noAuth.StatusCode)
	}

	wrongAuth := postJSON(t, proxy.URL+"/v1/chat/completions", "pcg_wrong-proxy-key", chatBody("test-model", false))
	if wrongAuth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected wrong proxy key (pcg_ prefix) to fail, got %d", wrongAuth.StatusCode)
	}

	// 비-proxy 형태(pcg_ 접두사가 아닌)의 토큰은 upstream passthrough 로 허용
	passthroughAuth := postJSON(t, proxy.URL+"/v1/chat/completions", "sk-upstream-key", chatBody("test-model", false))
	if passthroughAuth.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(passthroughAuth.Body)
		t.Fatalf("expected upstream key passthrough to pass, got %d: %s", passthroughAuth.StatusCode, body)
	}

	okAuth := postJSON(t, proxy.URL+"/v1/chat/completions", "proxy-secret", chatBody("test-model", false))
	if okAuth.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(okAuth.Body)
		t.Fatalf("expected valid proxy key to pass, got %d: %s", okAuth.StatusCode, body)
	}
}

func TestProviderHeaderRoutesToConfiguredProvider(t *testing.T) {
	defaultHit := make(chan struct{}, 1)
	defaultUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defaultHit <- struct{}{}
		http.Error(w, "default should not be used", http.StatusTeapot)
	}))
	defer defaultUpstream.Close()

	authSeen := make(chan string, 1)
	altUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"alt"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`))
	}))
	defer altUpstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(defaultUpstream.URL, "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	providerResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name":       "alt",
		"base_url":   altUpstream.URL,
		"api_key":    "alt-secret",
		"timeout_ms": 5000,
		"enabled":    true,
	})
	if providerResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(providerResp.Body)
		t.Fatalf("expected provider upsert status 200, got %d: %s", providerResp.StatusCode, body)
	}

	reqBody, err := json.Marshal(chatBody("test-model", false))
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Proxy-Provider", "alt")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected routed request status 200, got %d: %s", resp.StatusCode, body)
	}
	if got := <-authSeen; got != "Bearer alt-secret" {
		t.Fatalf("expected alt upstream auth, got %q", got)
	}
	select {
	case <-defaultHit:
		t.Fatal("default upstream was called despite X-Proxy-Provider")
	default:
	}

	logs, err := db.ListAdminAudit(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) == 0 || logs[0].Action != "provider.upsert" {
		t.Fatalf("expected provider upsert audit log, got %#v", logs)
	}

	// DELETE /admin/providers/alt
	reqDel, err := http.NewRequest(http.MethodDelete, proxy.URL+"/admin/providers/alt", nil)
	if err != nil {
		t.Fatal(err)
	}
	reqDel.Header.Set("Authorization", "Bearer default-secret")
	respDel, err := http.DefaultClient.Do(reqDel)
	if err != nil {
		t.Fatal(err)
	}
	defer respDel.Body.Close()
	if respDel.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(respDel.Body)
		t.Fatalf("expected delete provider status 200, got %d: %s", respDel.StatusCode, body)
	}

	// DELETE again should return 404
	respDelAgain, err := http.DefaultClient.Do(reqDel)
	if err != nil {
		t.Fatal(err)
	}
	defer respDelAgain.Body.Close()
	if respDelAgain.StatusCode != http.StatusNotFound {
		t.Fatalf("expected delete provider status 404 after deletion, got %d", respDelAgain.StatusCode)
	}

	// Verify delete audit log
	logsDel, err := db.ListAdminAudit(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logsDel) < 2 || logsDel[0].Action != "provider.delete" {
		t.Fatalf("expected provider.delete audit log at top, got %#v", logsDel)
	}
}

func TestOperationalHealthReadyMetricsAndFavicon(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	noRedirect := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	root, err := noRedirect.Get(proxy.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	root.Body.Close()
	if root.StatusCode != http.StatusFound || root.Header.Get("Location") != "/admin" || root.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("root redirect unexpected status=%d location=%q cache=%q", root.StatusCode, root.Header.Get("Location"), root.Header.Get("Cache-Control"))
	}
	missing, err := noRedirect.Get(proxy.URL + "/unknown-page")
	if err != nil {
		t.Fatal(err)
	}
	missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown root path should stay 404, got %d", missing.StatusCode)
	}

	for path, want := range map[string]string{"/health": `"status":"ok"`, "/ready": `"status":"ready"`} {
		resp, err := http.Get(proxy.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), want) {
			t.Fatalf("%s returned status=%d body=%s", path, resp.StatusCode, body)
		}
	}
	for _, request := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/health"},
		{method: http.MethodDelete, path: "/ready"},
		{method: http.MethodPost, path: "/admin/stats"},
	} {
		req, err := http.NewRequest(request.method, proxy.URL+request.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != http.MethodGet {
			t.Errorf("%s %s returned status=%d allow=%q, want 405 Allow=GET", request.method, request.path, resp.StatusCode, resp.Header.Get("Allow"))
		}
	}
	metrics, err := http.Get(proxy.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	metricsBody, _ := io.ReadAll(metrics.Body)
	metrics.Body.Close()
	if metrics.StatusCode != http.StatusOK || !strings.Contains(metrics.Header.Get("Content-Type"), "text/plain") || !strings.Contains(string(metricsBody), "proxy_requests_total") {
		t.Fatalf("metrics response unexpected status=%d content-type=%q body=%s", metrics.StatusCode, metrics.Header.Get("Content-Type"), metricsBody)
	}
	favicon, err := http.Get(proxy.URL + "/favicon.ico")
	if err != nil {
		t.Fatal(err)
	}
	faviconBody, _ := io.ReadAll(favicon.Body)
	favicon.Body.Close()
	if favicon.StatusCode != http.StatusOK || !strings.Contains(favicon.Header.Get("Content-Type"), "image/svg+xml") || !strings.Contains(string(faviconBody), "<svg") {
		t.Fatalf("favicon response unexpected status=%d content-type=%q body=%s", favicon.StatusCode, favicon.Header.Get("Content-Type"), faviconBody)
	}
}

// openTestStore gives a test its own database. TEST_POSTGRES_DSN runs the package
// against PostgreSQL instead, each test in its own schema — the store package found three
// PostgreSQL-only defects that way, and the handlers here issue queries of their own.
func openTestStore(t *testing.T) *store.SQLStore {
	t.Helper()
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		return openPostgresTestStore(t, dsn)
	}
	db, err := store.Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite",
		DSN:    filepath.Join(t.TempDir(), "gateway.db"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openPostgresTestStore(t *testing.T, dsn string) *store.SQLStore {
	t.Helper()
	schema := "t" + strings.ToLower(regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(t.Name(), "_"))
	if len(schema) > 55 {
		schema = schema[:55]
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	db, err := store.Open(context.Background(), config.DatabaseConfig{Driver: "postgres", DSN: dsn + sep + "search_path=" + schema})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate on postgres: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func testConfig(upstreamURL string, upstreamKey string) config.Config {
	return config.Config{
		ListenAddr: ":0",
		Upstream: config.UpstreamConfig{
			Provider: "test",
			BaseURL:  upstreamURL,
			APIKey:   upstreamKey,
			Timeout:  5 * time.Second,
		},
		Database: config.DatabaseConfig{Driver: "sqlite"},
		Logging: config.LoggingConfig{
			ResponseMaxBytes: 4096,
			QueueSize:        32,
		},
		Secret: config.SecretConfig{GatewaySecret: "test-secret"},
		Pricing: map[string]config.ModelPrice{
			"test-model": {InputKRWPer1M: 1, OutputKRWPer1M: 2},
		},
	}
}

func chatBody(model string, stream bool) map[string]any {
	return map[string]any{
		"model":  model,
		"stream": stream,
		"messages": []map[string]string{
			{"role": "user", "content": "hello from main.go"},
		},
	}
}

func postJSON(t *testing.T, url string, bearer string, body any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func patchJSON(t *testing.T, url string, bearer string, body any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func waitFor(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestUnregisteredAPIPathPassthrough(t *testing.T) {
	upstreamHit := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"response content"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Create a proxy key so we can authenticate
	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{
		"name":  "User Key",
		"key":   "user-secret",
		"owner": "bob",
		"team":  "dev",
	})
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected key creation status 201, got %d", createResp.StatusCode)
	}

	// Request unregistered path
	reqBody, _ := json.Marshal(chatBody("test-model", false))
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/responses", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer user-secret")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected status 200, got %d: %s", resp.StatusCode, body)
	}

	select {
	case path := <-upstreamHit:
		if path != "/v1/responses" {
			t.Fatalf("expected upstream path /v1/responses, got %s", path)
		}
	case <-time.After(time.Second):
		t.Fatal("upstream not hit")
	}

	waitFor(t, time.Second, func() bool {
		recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return err == nil && len(recent) == 1 && recent[0].Endpoint == "/v1/responses"
	})
}

func TestEarlyPipelineBlockLogging(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig("http://example.invalid", "default-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Create a proxy key first to enforce API key check, otherwise it falls back to anonymous/passthrough
	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{
		"name":  "User Key",
		"key":   "user-secret",
		"owner": "bob",
		"team":  "dev",
	})
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected key creation status 201, got %d", createResp.StatusCode)
	}

	// Send request with invalid API key (using pcg_ prefix to treat it as a proxy key) to trigger stepAuth failure
	reqBody, _ := json.Marshal(chatBody("test-model", false))
	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer pcg_invalid-secret")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", resp.StatusCode)
	}

	waitFor(t, time.Second, func() bool {
		recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		if err == nil && len(recent) > 0 {
			t.Logf("recent request logged: ID=%s, StatusCode=%d, Error=%q", recent[0].ID, recent[0].StatusCode, recent[0].Error)
		}
		return err == nil && len(recent) == 1 && recent[0].StatusCode == http.StatusUnauthorized && recent[0].Error == "early_blocked"
	})
}
