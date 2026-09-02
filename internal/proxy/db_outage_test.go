package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// What the gateway does when its database goes away.
//
// This is a designed-for scenario, not a hypothetical: the async logger writes to a
// fallback NDJSON file precisely so an outage does not lose the audit trail, and there is
// an endpoint to replay it afterwards. But nothing checked what a client sees while it is
// happening, and the answer was wrong.
//
// Credentials cannot be verified with the store down, so the request must be refused —
// allowing it through unverified would be worse. What the caller was told is the problem:
// 401 "invalid proxy API key". That is wrong twice. It sends an operator to reissue keys
// during a database incident, and 401 is not a retryable status, so SDKs and clients
// treat a transient outage as a permanent credential failure and stop.
func TestDatabaseOutageIsReportedAsAnOutageNotABadKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	fallback := filepath.Join(t.TempDir(), "fallback.ndjson")
	logger := store.NewAsyncLogger(db, 64, fallback)
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "s")
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	chat := func() (*http.Response, string) {
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions",
			bytes.NewReader(chatBodyWith("sys", "hello", 0)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		resp.Body.Close()
		return resp, string(body)
	}

	// Healthy first: without this the assertions below could pass on a gateway that was
	// broken all along rather than broken by the outage.
	if resp, body := chat(); resp.StatusCode != http.StatusOK {
		t.Fatalf("before the outage the gateway should serve: got %d %s", resp.StatusCode, body)
	}

	if err := db.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}

	resp, body := chat()
	if resp.StatusCode == http.StatusUnauthorized {
		t.Errorf("a database outage was reported to the client as 401: %s\n"+
			"401 tells the caller their credentials are wrong and that retrying will not help. "+
			"Neither is true here.", body)
	}
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("during a database outage the gateway answered %d; want 503 so callers retry", resp.StatusCode)
	}
	if ra := resp.Header.Get("Retry-After"); ra == "" {
		t.Error("no Retry-After on the outage response; a retryable status should say when")
	}
	var parsed struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("outage response was not the usual error envelope: %s", body)
	}
	if parsed.Error.Code == "invalid_api_key" {
		t.Errorf("outage reported with code %q, which points the reader at their key", parsed.Error.Code)
	}
	if !strings.Contains(parsed.Error.Message, "database") {
		t.Errorf("the outage message does not mention the database, so nobody reading it "+
			"will know where to look: %q", parsed.Error.Message)
	}

	// Refusing is still the right policy: unverifiable must never mean allowed.
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		t.Error("the request was served while credentials could not be verified")
	}

	// Liveness stays up (the process is fine); readiness goes down (it cannot serve).
	// Both matter to a load balancer, and they must not agree here.
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/health", http.StatusOK},
		{"/ready", http.StatusServiceUnavailable},
	} {
		r, err := http.Get(proxy.URL + tc.path)
		if err != nil {
			t.Fatalf("GET %s: %v", tc.path, err)
		}
		probeBody, readErr := io.ReadAll(r.Body)
		r.Body.Close()
		if readErr != nil {
			t.Fatalf("read GET %s response: %v", tc.path, readErr)
		}
		if r.StatusCode != tc.want {
			t.Errorf("GET %s during the outage returned %d, want %d", tc.path, r.StatusCode, tc.want)
		}
		if tc.path == "/ready" {
			if strings.Contains(string(probeBody), "sql:") || strings.Contains(string(probeBody), "database is closed") {
				t.Errorf("public readiness response leaked internal database details: %s", probeBody)
			}
			if !strings.Contains(string(probeBody), `"error":"database unavailable"`) {
				t.Errorf("public readiness response lacks a safe operator message: %s", probeBody)
			}
		}
	}

	// And the audit trail survived it: the reason the fallback file exists.
	deadline := time.Now().Add(3 * time.Second)
	for {
		info, err := os.Stat(fallback)
		if err == nil && info.Size() > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("nothing was written to the fallback log during the outage; " +
				"the records the database could not take were lost")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
