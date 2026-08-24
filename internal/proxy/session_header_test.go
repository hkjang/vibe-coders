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

	"vibe-coders/internal/store"
)

// Giving the upstream a session id when the caller sends none.
//
// qwen code sends nothing that identifies a conversation to a generic OpenAI-compatible
// endpoint — no session header, no body field — so every turn reaches the provider looking
// unrelated to the one before it. The gateway already has to work out which conversation a
// request belongs to in order to keep it on one provider, so it now passes that identity
// on as X-Session-ID.
//
// What matters is that the id is stable for a conversation and distinct between
// conversations. An id that changed per turn would be worse than none: it would look like
// a session boundary on every request.

func sessionHeaderFixture(t *testing.T) (proxyURL string, seen *[]string) {
	t.Helper()
	var mu sync.Mutex
	got := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.Header.Get("X-Session-ID"))
		mu.Unlock()
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
	cfg.Auth.AdminToken = "rw"
	cfg.Session.InjectHeader = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts.URL, &got
}

// turn sends one qwen-code-shaped request: same UA, no session header, the conversation
// carried entirely in the messages array.
func turnAs(t *testing.T, proxyURL, system, firstUser string, turnIdx int, clientSession string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, proxyURL+"/v1/chat/completions",
		bytes.NewReader(chatBodyWith(system, firstUser, turnIdx)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "QwenCode/0.2.1 (linux; x64)")
	if clientSession != "" {
		req.Header.Set("X-Session-ID", clientSession)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status %d", resp.StatusCode)
	}
	return resp.Header.Get("X-Session-ID")
}

func TestSessionIDIsStableAcrossTurnsOfOneConversation(t *testing.T) {
	proxyURL, seen := sessionHeaderFixture(t)

	var echoed []string
	for turn := 0; turn < 4; turn++ {
		echoed = append(echoed, turnAs(t, proxyURL, "You are a coding agent.", "refactor auth.go", turn, ""))
	}

	first := (*seen)[0]
	if first == "" {
		t.Fatal("the upstream received no X-Session-ID; nothing was attached to a request that carried none")
	}
	for i, got := range *seen {
		if got != first {
			t.Errorf("turn %d reached the upstream as session %q, turn 0 as %q — an id that "+
				"changes per turn looks like a new session on every request", i, got, first)
		}
	}
	// The client is told which id was chosen, so it can start sending it itself.
	for i, got := range echoed {
		if got != first {
			t.Errorf("turn %d echoed %q downstream but sent %q upstream", i, got, first)
		}
	}
}

func TestDifferentConversationsGetDifferentSessionIDs(t *testing.T) {
	proxyURL, seen := sessionHeaderFixture(t)

	turnAs(t, proxyURL, "You are a coding agent.", "refactor auth.go", 0, "")
	turnAs(t, proxyURL, "You are a coding agent.", "write tests for parser.go", 0, "")

	if len(*seen) != 2 {
		t.Fatalf("expected two upstream calls, got %d", len(*seen))
	}
	if (*seen)[0] == (*seen)[1] {
		t.Errorf("two separate conversations were given the same session id %q; the provider "+
			"cannot tell them apart and prefix caching would be attributed to one of them", (*seen)[0])
	}
}

// A client that already identifies its conversations knows better than the gateway does,
// so its id must reach the upstream untouched.
func TestAClientSuppliedSessionIDIsNotReplaced(t *testing.T) {
	proxyURL, seen := sessionHeaderFixture(t)

	turnAs(t, proxyURL, "You are a coding agent.", "refactor auth.go", 0, "client-owned-42")

	if len(*seen) != 1 {
		t.Fatalf("expected one upstream call, got %d", len(*seen))
	}
	if (*seen)[0] != "client-owned-42" {
		t.Errorf("the caller's own session id was replaced with %q", (*seen)[0])
	}
}

// Turning it off has to actually turn it off: an operator whose provider rejects unknown
// headers needs the request to go out as it arrived.
func TestSessionHeaderInjectionCanBeDisabled(t *testing.T) {
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("X-Session-ID"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "s")
	cfg.Session.InjectHeader = false
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	defer ts.Close()

	body, _ := json.Marshal(map[string]any{"model": "test-model",
		"messages": []map[string]string{{"role": "user", "content": "hi"}}})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if len(seen) != 1 || seen[0] != "" {
		t.Errorf("with injection disabled the upstream still received a session id %q", seen)
	}
}

// The injected id must not be recorded as something the client sent.
//
// The header is added to the inbound request so copyUpstreamHeaders forwards it, which
// means anything reading r.Header after that point sees a header the caller never sent.
// The audit capture happens before the pipeline runs, so the request log shows what
// actually arrived — but that is an ordering accident waiting to be undone, and the
// symptom would be quiet: an operator debugging a client would see X-Session-ID in the
// recorded request and conclude the client is sending one.
func TestTheInjectedSessionIDIsNotRecordedAsClientSent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "s")
	cfg.Session.InjectHeader = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	// auditRequest is what captures the client's headers; call it the way the request
	// path does and check the pipeline has not already written into r.Header.
	body, _ := json.Marshal(map[string]any{"model": "test-model",
		"messages": []map[string]string{{"role": "user", "content": "hi"}}})
	req, err := http.NewRequest(http.MethodPost, "http://gateway/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "QwenCode/0.2.1")

	record := server.auditRequest("/v1/chat/completions", body, "anonymous", "trace-1", req)
	if strings.Contains(strings.ToLower(record.Request.RequestHeadersJSON), "session-id") {
		t.Errorf("the request log records a session id the caller never sent:\n  %s\n"+
			"The header is added for the upstream only; recording it makes a client look "+
			"like it is sending one when it is not.", record.Request.RequestHeadersJSON)
	}

	// And the end-to-end path still attaches it upstream, so this is not passing because
	// injection stopped working.
	proxyURL, seen := sessionHeaderFixture(t)
	turnAs(t, proxyURL, "You are a coding agent.", "refactor auth.go", 0, "")
	if len(*seen) != 1 || (*seen)[0] == "" {
		t.Fatalf("the upstream received no session id, so the check above proves nothing: %v", *seen)
	}
}
