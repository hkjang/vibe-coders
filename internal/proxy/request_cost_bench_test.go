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
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// What one request costs the gateway itself.
//
// The upstream here does nothing, so what this measures is the gateway's own per-byte
// work: parsing the body, extracting and redacting prompts, scoring complexity and risk,
// and writing the audit record. That cost is linear in the request size and it was easy
// to miss — nothing fails, requests are just slower and allocate more than they look
// like they should.
//
//	go test ./internal/proxy/ -run XXX -bench BenchmarkChatRequest -benchmem
//
// For a profile, add -cpuprofile and read it with `go tool pprof -top -cum`; note that
// listing is flat, not a call tree, so two entries with the same cumulative time are not
// evidence that one calls the other.
func benchmarkChatRequest(b *testing.B, sizeMB int) { benchmarkChatRequestBytes(b, sizeMB<<20) }

func benchmarkChatRequestBytes(b *testing.B, size int) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db, err := store.Open(context.Background(), config.DatabaseConfig{
		Driver: "sqlite", DSN: filepath.Join(b.TempDir(), "bench.db")})
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(context.Background()); err != nil {
		b.Fatal(err)
	}
	logger := store.NewAsyncLogger(db, 256, filepath.Join(b.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "s"), db, logger, nil)
	if err != nil {
		b.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()

	body, err := json.Marshal(map[string]any{"model": "test-model",
		"messages": []map[string]string{{"role": "user", "content": strings.Repeat("A", size)}}})
	if err != nil {
		b.Fatal(err)
	}

	b.ResetTimer()
	b.SetBytes(int64(len(body)))
	for i := 0; i < b.N; i++ {
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", bytes.NewReader(body))
		if err != nil {
			b.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			b.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

func BenchmarkChatRequest1MB(b *testing.B) { benchmarkChatRequest(b, 1) }

// A load-test shaped request: a couple of kilobytes, which is what a real agent turn
// looks like. The per-byte work barely registers at this size, so what this measures is
// the fixed cost every request pays regardless of how small it is.
func BenchmarkChatRequestSmall(b *testing.B) { benchmarkChatRequestBytes(b, 2<<10) }
