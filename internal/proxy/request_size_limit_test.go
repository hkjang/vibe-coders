package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// The request size limit has to bound the read, not just the verdict.
//
// limits.max_request_bytes was checked after the body had already been read in full. A
// 5 MB body against a 1 KB limit was read entirely — the 413 reported
// X-Request-Bytes: 5242944, a number it could only know by reading all of it — and only
// then refused. The upstream was protected; the gateway was not, and enough concurrent
// callers could exhaust it while the operator believed the setting covered that.
//
// The read is now wrapped, so it stops at the ceiling. The boundary is unchanged: a body
// of exactly the limit passes, one byte more does not.

func sizeLimitServer(t *testing.T, maxBytes int) string {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`))
	}))
	t.Cleanup(upstream.Close)

	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })

	cfg := testConfig(upstream.URL, "s")
	cfg.Limits.MaxRequestBytes = maxBytes
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts.URL
}

func postBody(t *testing.T, url string, body []byte) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
	resp.Body.Close()
	return resp.StatusCode, string(payload)
}

// bodyOfSize builds a valid chat request whose encoded length is exactly n bytes.
func bodyOfSize(t *testing.T, n int) []byte {
	t.Helper()
	build := func(fill int) []byte {
		b, err := json.Marshal(map[string]any{"model": "test-model",
			"messages": []map[string]string{{"role": "user", "content": strings.Repeat("A", fill)}}})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	base := len(build(0))
	if n < base {
		t.Fatalf("cannot build a body smaller than the %d byte envelope", base)
	}
	body := build(n - base)
	if len(body) != n {
		t.Fatalf("built a %d byte body, wanted %d", len(body), n)
	}
	return body
}

func TestOversizedRequestIsRefusedWithoutReadingItAll(t *testing.T) {
	const limit = 1000
	url := sizeLimitServer(t, limit)

	huge := bodyOfSize(t, 5<<20)
	status, payload := postBody(t, url, huge)

	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a %d byte body against a %d byte limit returned %d, want 413", len(huge), limit, status)
	}
	// The old code reported the body's real size, which it could only know by reading
	// every byte of it. If that number is back, so is the unbounded read.
	if strings.Contains(payload, strconv.Itoa(len(huge))) {
		t.Errorf("the refusal names the body's full size (%d), so the whole body was read "+
			"before it was refused:\n  %s", len(huge), payload)
	}
	if !strings.Contains(payload, "payload_too_large") {
		t.Errorf("unexpected error shape: %s", payload)
	}
}

// The boundary must not move: wrapping the reader at limit+1 has to keep accepting a body
// of exactly the limit, or the setting quietly means one byte less than it says.
func TestABodyExactlyAtTheLimitIsAccepted(t *testing.T) {
	const limit = 4096
	url := sizeLimitServer(t, limit)

	if status, payload := postBody(t, url, bodyOfSize(t, limit)); status != http.StatusOK {
		t.Errorf("a body of exactly %d bytes was refused with %d: %s", limit, status, payload)
	}
	if status, _ := postBody(t, url, bodyOfSize(t, limit+1)); status != http.StatusRequestEntityTooLarge {
		t.Errorf("a body of %d bytes against a %d byte limit returned %d, want 413", limit+1, limit, status)
	}
}

// Zero means disabled, and disabled has to mean no ceiling — otherwise deployments that
// never set this would start refusing large but legitimate requests.
func TestNoLimitConfiguredMeansNoCeiling(t *testing.T) {
	url := sizeLimitServer(t, 0)
	if status, payload := postBody(t, url, bodyOfSize(t, 2<<20)); status != http.StatusOK {
		t.Errorf("with no limit configured a 2 MB body returned %d: %.200s", status, payload)
	}
}
