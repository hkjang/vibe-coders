package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestEmbeddingCacheHitsServeWithoutUpstream(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2,0.3],"index":0}],"model":"text-embed-3","usage":{"prompt_tokens":3,"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Cache.EmbeddingEnabled = true
	cfg.Cache.EmbeddingTTL = time.Hour
	cfg.Cache.EmbeddingMaxBytes = 1 << 20
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	body := map[string]any{"model": "text-embed-3", "input": "hello"}
	first := postJSON(t, proxy.URL+"/v1/embeddings", "", body)
	first.Body.Close()
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first embeddings call expected 200, got %d", first.StatusCode)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 upstream call, got %d", hits.Load())
	}

	// wait for cache to be written (synchronous now, but be safe)
	time.Sleep(50 * time.Millisecond)

	second := postJSON(t, proxy.URL+"/v1/embeddings", "", body)
	defer second.Body.Close()
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second embeddings call expected 200, got %d", second.StatusCode)
	}
	if second.Header.Get("X-Cache") != "HIT" {
		t.Fatalf("expected X-Cache=HIT, got %q", second.Header.Get("X-Cache"))
	}
	if hits.Load() != 1 {
		t.Fatalf("expected upstream to NOT be called again, got %d total hits", hits.Load())
	}

	// stats endpoint includes cache info
	statsResp, err := http.Get(proxy.URL + "/admin/stats")
	if err != nil {
		t.Fatal(err)
	}
	defer statsResp.Body.Close()
	var stats map[string]any
	if err := json.NewDecoder(statsResp.Body).Decode(&stats); err != nil {
		t.Fatal(err)
	}
	if got, _ := stats["cache_hits"].(float64); got < 1 {
		t.Fatalf("expected cache_hits >= 1, got %v", stats["cache_hits"])
	}
	if _, ok := stats["latency_quantiles"]; !ok {
		t.Fatal("expected latency_quantiles in /admin/stats")
	}
	if _, ok := stats["first_chunk_quantiles"]; !ok {
		t.Fatal("expected first_chunk_quantiles in /admin/stats")
	}
}

func TestUpstreamFailoverTriesNextProvider(t *testing.T) {
	deadHit := make(chan struct{}, 1)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadHit <- struct{}{}
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		conn, _, _ := hj.Hijack()
		conn.Close() // simulate transport-level failure mid-handshake
	}))
	defer dead.Close()

	aliveHit := make(chan struct{}, 1)
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aliveHit <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"alive"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer alive.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(dead.URL, "dead-secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// configure dead primary (alphabetically first) and alive backup; both match foo-*
	for _, p := range []map[string]any{
		{"name": "alpha-dead", "base_url": dead.URL, "api_key": "dead-secret", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
		{"name": "zeta-alive", "base_url": alive.URL, "api_key": "alive-secret", "timeout_ms": 1000, "enabled": true, "model_patterns": "foo-*"},
	} {
		resp := postJSON(t, proxy.URL+"/admin/providers", "", p)
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("provider upsert %s failed: %d %s", p["name"], resp.StatusCode, body)
		}
		resp.Body.Close()
	}

	out := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("foo-1", false))
	defer out.Body.Close()
	if out.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(out.Body)
		t.Fatalf("expected 200 after failover, got %d: %s", out.StatusCode, body)
	}
	if out.Header.Get("X-Failover-From") == "" {
		t.Fatal("expected X-Failover-From header")
	}
	select {
	case <-deadHit:
	case <-time.After(time.Second):
		t.Fatal("expected dead provider to have been tried")
	}
	select {
	case <-aliveHit:
	case <-time.After(time.Second):
		t.Fatal("expected alive provider to have been used as failover")
	}
}

func TestLatencyDigestQuantiles(t *testing.T) {
	d := newLatencyDigest()
	for i := int64(1); i <= 100; i++ {
		d.Observe(i)
	}
	q := d.Quantiles(0.5, 0.95, 0.99)
	if q[0] < 49 || q[0] > 51 {
		t.Fatalf("p50 ~ 50, got %d", q[0])
	}
	if q[1] < 94 || q[1] > 96 {
		t.Fatalf("p95 ~ 95, got %d", q[1])
	}
	if q[2] < 98 || q[2] > 100 {
		t.Fatalf("p99 ~ 99, got %d", q[2])
	}
}
