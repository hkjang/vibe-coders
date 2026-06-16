package proxy

import (
	"context"
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

func TestClickHouseRequestFactSink(t *testing.T) {
	var mu sync.Mutex
	bodies := []string{}
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "INSERT INTO") {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			bodies = append(bodies, string(b))
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ch.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://upstream.invalid", "secret")
	cfg.ClickHouse.URL = ch.URL
	cfg.ClickHouse.RequestFactTable = "ai_request_fact"
	cfg.ClickHouse.BatchSize = 1 // flush immediately on enqueue
	cfg.ClickHouse.FlushInterval = 200 * time.Millisecond
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	server.enqueue(store.LogRecord{
		Request: store.RequestLog{
			ID: "req-fact-1", TraceID: "tr1", Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
			Provider: "openai", StatusCode: 200, ClientIP: "203.0.113.9", LatencyMS: 120, CreatedAt: time.Now().UTC(),
		},
		Usage: &store.TokenUsage{RequestID: "req-fact-1", PromptTokens: 5, CompletionTokens: 7, TotalTokens: 12, EstimatedCost: 9.5, Currency: "KRW"},
	})

	var got string
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, b := range bodies {
			if strings.Contains(b, "req-fact-1") {
				got = b
				return true
			}
		}
		return false
	})

	if !strings.Contains(got, `"model":"gpt-4.1"`) {
		t.Errorf("fact row missing model: %s", got)
	}
	if !strings.Contains(got, `"client_ip_hash"`) {
		t.Errorf("fact row missing client_ip_hash: %s", got)
	}
	if strings.Contains(got, "203.0.113.9") {
		t.Errorf("raw client IP must not be shipped, got: %s", got)
	}
	if !strings.Contains(got, `"total_tokens":12`) {
		t.Errorf("fact row missing token usage: %s", got)
	}
}

func TestClickHouseRequestFactDisabledNoQueue(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "f.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	// No RequestFactTable → enqueue is a safe no-op (no panic, nothing dropped meaningfully).
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.enqueue(store.LogRecord{Request: store.RequestLog{ID: "x", CreatedAt: time.Now().UTC()}})
}
