package proxy

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSessionInfererSlidingWindow(t *testing.T) {
	si := newSessionInferer(30 * time.Minute)
	t0 := time.Date(2026, 6, 10, 9, 0, 0, 0, time.UTC)

	a1 := si.sessionFor("alice", t0)
	if !strings.HasPrefix(a1, "sess_") {
		t.Fatalf("expected sess_ prefix, got %q", a1)
	}
	// within the idle window → same session, window slides forward
	a2 := si.sessionFor("alice", t0.Add(20*time.Minute))
	if a2 != a1 {
		t.Fatalf("within window should reuse: %q != %q", a2, a1)
	}
	a3 := si.sessionFor("alice", t0.Add(45*time.Minute)) // 25m after a2 (<30m) → still same
	if a3 != a1 {
		t.Fatalf("sliding window should reuse: %q != %q", a3, a1)
	}
	// gap longer than idle → new session
	a4 := si.sessionFor("alice", t0.Add(45*time.Minute+31*time.Minute))
	if a4 == a1 {
		t.Fatalf("after idle gap should mint a new session, got same %q", a4)
	}
	// different identity → different session
	b1 := si.sessionFor("bob", t0)
	if b1 == a1 {
		t.Fatalf("different identity must not collide: %q", b1)
	}
}

func TestExplicitSessionExtraction(t *testing.T) {
	mk := func(headers map[string]string, body string) llmMetadata {
		r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return llmRequestMetadata(r, []byte(body), "trace-xyz")
	}

	cases := []struct {
		name    string
		headers map[string]string
		body    string
		want    string
	}{
		{"langflow body session_id", nil, `{"model":"m","session_id":"lf-123","messages":[]}`, "lf-123"},
		{"openwebui chat_id", nil, `{"model":"m","chat_id":"owui-9","messages":[]}`, "owui-9"},
		{"conversation_id", nil, `{"model":"m","conversation_id":"c-1","messages":[]}`, "c-1"},
		{"openai metadata.session_id", nil, `{"model":"m","metadata":{"session_id":"md-7"},"messages":[]}`, "md-7"},
		{"X-Session-ID header", map[string]string{"X-Session-ID": "hdr-1"}, `{"model":"m","messages":[]}`, "hdr-1"},
		{"X-Vibe-Session-ID header", map[string]string{"X-Vibe-Session-ID": "vibe-2"}, `{"model":"m","messages":[]}`, "vibe-2"},
		{"header beats body", map[string]string{"X-Session-ID": "hdr-win"}, `{"model":"m","session_id":"body-lose","messages":[]}`, "hdr-win"},
		{"no explicit → empty", nil, `{"model":"m","messages":[]}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := mk(c.headers, c.body).SessionID
			if got != c.want {
				t.Fatalf("session id = %q, want %q", got, c.want)
			}
		})
	}
}

// buildInferServer spins up a Server with session inference toggled as requested.
func buildInferServer(t *testing.T, inference bool) *Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://example.invalid", "secret")
	cfg.Session.InferenceEnabled = inference
	cfg.Session.IdleTimeout = 30 * time.Minute
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func reqFor(body, ua, remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader([]byte(body)))
	r.RemoteAddr = remote
	r.Header.Set("User-Agent", ua)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestAuditRequestInfersAndGroups(t *testing.T) {
	s := buildInferServer(t, true)
	body := `{"model":"qwen3-coder-plus","messages":[{"role":"user","content":"hi"}]}`

	// same client identity, no explicit session → grouped into one inferred session
	r1 := reqFor(body, "qwen-code/1.0", "10.0.0.5:5000", nil)
	r2 := reqFor(body, "qwen-code/1.0", "10.0.0.5:5111", nil) // different source port, same IP
	rec1 := s.auditRequest("/v1/chat/completions", []byte(body), "key_a", "t1", r1)
	rec2 := s.auditRequest("/v1/chat/completions", []byte(body), "key_a", "t2", r2)
	if rec1.Request.SessionID != rec2.Request.SessionID {
		t.Fatalf("same client should share inferred session: %q vs %q", rec1.Request.SessionID, rec2.Request.SessionID)
	}
	if !strings.HasPrefix(rec1.Request.SessionID, "sess_") {
		t.Fatalf("inferred session should have sess_ prefix, got %q", rec1.Request.SessionID)
	}

	// a different tool (user-agent) on the same IP/key → a different session
	r3 := reqFor(body, "cursor/0.42", "10.0.0.5:5222", nil)
	rec3 := s.auditRequest("/v1/chat/completions", []byte(body), "key_a", "t3", r3)
	if rec3.Request.SessionID == rec1.Request.SessionID {
		t.Fatalf("different tool should not share session")
	}

	// explicit body session id always wins over inference
	explicit := `{"model":"m","session_id":"explicit-42","messages":[{"role":"user","content":"x"}]}`
	r4 := reqFor(explicit, "qwen-code/1.0", "10.0.0.5:5333", nil)
	rec4 := s.auditRequest("/v1/chat/completions", []byte(explicit), "key_a", "t4", r4)
	if rec4.Request.SessionID != "explicit-42" {
		t.Fatalf("explicit session must win, got %q", rec4.Request.SessionID)
	}
}

func TestAuditRequestInferenceDisabledFallsBackToTrace(t *testing.T) {
	s := buildInferServer(t, false)
	body := `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
	r := reqFor(body, "qwen-code/1.0", "10.0.0.9:6000", nil)
	rec := s.auditRequest("/v1/chat/completions", []byte(body), "key_b", "trace-legacy", r)
	if rec.Request.SessionID != "trace:trace-legacy" {
		t.Fatalf("inference disabled should fall back to trace:, got %q", rec.Request.SessionID)
	}
}

func TestInferredSessionRecoversAcrossServerRestart(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig("http://example.invalid", "secret")
	cfg.Session.InferenceEnabled = true
	cfg.Session.IdleTimeout = 30 * time.Minute

	s1, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
	r1 := reqFor(body, "cursor/1.0", "10.0.0.7:5000", map[string]string{"X-Vibe-Repo": "vibe-coders"})
	t0 := time.Date(2026, 6, 12, 9, 0, 0, 0, time.UTC)
	first := s1.inferSessionID(r1, "key_restart", t0)
	if first == "" {
		t.Fatal("expected inferred session id")
	}

	s2, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	r2 := reqFor(body, "cursor/1.0", "10.0.0.7:5111", map[string]string{"X-Vibe-Repo": "vibe-coders"})
	recovered := s2.inferSessionID(r2, "key_restart", t0.Add(5*time.Minute))
	if recovered != first {
		t.Fatalf("restart should recover session %q, got %q", first, recovered)
	}

	expired := s2.inferSessionID(r2, "key_restart", t0.Add(37*time.Minute))
	if expired == first {
		t.Fatalf("idle timeout should mint a new session after recovery, still got %q", expired)
	}
}
