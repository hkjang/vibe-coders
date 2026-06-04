package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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

	wrongAuth := postJSON(t, proxy.URL+"/v1/chat/completions", "wrong-secret", chatBody("test-model", false))
	if wrongAuth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected wrong proxy key to fail, got %d", wrongAuth.StatusCode)
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
}

func openTestStore(t *testing.T) *store.SQLStore {
	t.Helper()
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
