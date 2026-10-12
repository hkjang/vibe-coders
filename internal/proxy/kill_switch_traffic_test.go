package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestProxyInflightCountsConcurrentCancellationAndEarlyExit(t *testing.T) {
	entered := make(chan struct{}, 3)
	unblock := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(unblock) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-unblock:
		}
	}))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "public-upstream-token"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	requestContext, cancelRequests := context.WithCancel(ctx)
	defer cancelRequests()
	requestBody, err := json.Marshal(chatBody("test-model", false))
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 3 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			req, err := http.NewRequestWithContext(requestContext, http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(requestBody))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}()
	}
	for range 3 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("concurrent requests did not enter upstream")
		}
	}
	if got := server.metrics.proxyInflight.Load(); got != 3 {
		t.Fatalf("inflight=%d, want3", got)
	}
	if !strings.Contains(server.metrics.Prometheus(0, 0, 0), "# TYPE proxy_inflight_requests gauge\nproxy_inflight_requests 3\n") {
		t.Fatal("Prometheus gauge does not match live handlers")
	}
	cancelRequests()
	workers.Wait()
	for server.metrics.proxyInflight.Load() != 0 {
		select {
		case <-ctx.Done():
			t.Fatal("cancelled handlers did not release the gauge")
		case <-time.After(5 * time.Millisecond):
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, proxy.URL+"/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatal("method guard changed")
	}
	for server.metrics.proxyInflight.Load() != 0 {
		select {
		case <-ctx.Done():
			t.Fatal("early-return handler did not release gauge")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestKillSwitchTrafficRequiresAdminRead(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig("http://example.invalid", "public-upstream-token")
	cfg.Auth.AdminToken = "public-write-token"
	cfg.Auth.AdminReadonlyToken = "public-read-token"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, token string
		status              int
	}{
		{"unauthenticated", http.MethodGet, "", http.StatusUnauthorized},
		{"readonly", http.MethodGet, "public-read-token", http.StatusOK},
		{"readonly-write-denied", http.MethodPost, "public-read-token", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/admin/kill-switch", strings.NewReader(`{"disabled":true,"reason":"public reason"}`))
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, req)
			if response.Code != tc.status {
				t.Fatalf("status=%d, want%d", response.Code, tc.status)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if tc.status != http.StatusOK {
				if _, present := payload["traffic"]; present {
					t.Fatal("denied caller received traffic metadata")
				}
				return
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("live observation must not be cached")
			}
			var traffic struct {
				Instance string `json:"instance_ref"`
				Inflight int64  `json:"proxy_inflight"`
			}
			if err := json.Unmarshal(payload["traffic"], &traffic); err != nil {
				t.Fatal(err)
			}
			if len(traffic.Instance) != 24 || !strings.HasPrefix(traffic.Instance, "process_") || traffic.Inflight != 0 {
				t.Fatal("invalid opaque idle observation")
			}
			if strings.Contains(response.Body.String(), server.instanceID) {
				t.Fatal("raw instance identity leaked")
			}
		})
	}
}
