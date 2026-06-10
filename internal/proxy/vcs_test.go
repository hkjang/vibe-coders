package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestExtractSessionMarker(t *testing.T) {
	cases := map[string]string{
		"refactor OrderController\n\nVibe-Session: sess_ab12cd34": "sess_ab12cd34",
		"fix bug [vibe:sess_xyz]":                                 "sess_xyz",
		"vibe session = sess_9":                                   "sess_9",
		"no marker here":                                          "",
	}
	for in, want := range cases {
		if got := extractSessionMarker(in); got != want {
			t.Errorf("marker(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseGitLabWebhook(t *testing.T) {
	push := map[string]any{
		"object_kind": "push",
		"ref":         "refs/heads/feature/x",
		"project":     map[string]any{"path_with_namespace": "team/repo", "web_url": "http://gl/team/repo"},
		"commits": []any{
			map[string]any{"id": "abc123", "message": "refactor\n\nVibe-Session: sess_1", "url": "http://gl/c/abc123", "author": map[string]any{"email": "a@x.com", "name": "Alice"}},
		},
	}
	evs := parseGitLabWebhook(push)
	if len(evs) != 1 || evs[0].Kind != "commit" || evs[0].Repo != "team/repo" || evs[0].Branch != "feature/x" || evs[0].Ref != "abc123" {
		t.Fatalf("gitlab push parse wrong: %+v", evs)
	}
	if evs[0].AuthorEmail != "a@x.com" {
		t.Errorf("author not parsed: %+v", evs[0])
	}

	mr := map[string]any{
		"object_kind": "merge_request",
		"project":     map[string]any{"path_with_namespace": "team/repo"},
		"user":        map[string]any{"name": "Bob"},
		"object_attributes": map[string]any{
			"iid": float64(42), "title": "Add feature", "state": "merged",
			"source_branch": "feature/x", "url": "http://gl/mr/42",
		},
	}
	evs = parseGitLabWebhook(mr)
	if len(evs) != 1 || evs[0].Kind != "merge_request" || evs[0].Ref != "42" || evs[0].State != "merged" || evs[0].Title != "Add feature" {
		t.Fatalf("gitlab MR parse wrong: %+v", evs)
	}
}

func TestParseBitbucketWebhook(t *testing.T) {
	// Bitbucket Server PR merged
	server := map[string]any{
		"eventKey": "pr:merged",
		"actor":    map[string]any{"displayName": "Carol", "emailAddress": "c@x.com"},
		"pullRequest": map[string]any{
			"id": float64(7), "title": "Server PR [vibe:sess_bb]",
			"fromRef": map[string]any{"displayId": "feature/y", "repository": map[string]any{"name": "svc"}},
		},
	}
	evs := parseBitbucketWebhook("pr:merged", server)
	if len(evs) != 1 || evs[0].Kind != "merge_request" || evs[0].State != "merged" || evs[0].Ref != "7" || evs[0].Repo != "svc" {
		t.Fatalf("bitbucket server PR parse wrong: %+v", evs)
	}

	// Bitbucket Cloud PR created
	cloud := map[string]any{
		"repository":  map[string]any{"full_name": "team/svc"},
		"pullrequest": map[string]any{"id": float64(3), "title": "Cloud PR", "source": map[string]any{"branch": map[string]any{"name": "feature/z"}}, "author": map[string]any{"display_name": "Dan"}},
	}
	evs = parseBitbucketWebhook("pullrequest:created", cloud)
	if len(evs) != 1 || evs[0].State != "opened" || evs[0].Repo != "team/svc" || evs[0].Branch != "feature/z" {
		t.Fatalf("bitbucket cloud PR parse wrong: %+v", evs)
	}
}

func newVCSServer(t *testing.T, secret string) (*Server, *store.SQLStore, *httptest.Server) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://example.invalid", "secret")
	cfg.VCS.WebhookSecret = secret
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return server, db, proxy
}

func TestVCSGenericIngestCorrelatesSessionAndUser(t *testing.T) {
	_, db, proxy := newVCSServer(t, "vcs-secret")
	ctx := context.Background()

	// a session with traffic under key_alice → SessionPrimaryAPIKey should resolve it
	_ = db.InsertLogRecord(ctx, store.LogRecord{
		Request: store.RequestLog{ID: "r1", TraceID: "r1", SessionID: "sess_proj", APIKeyID: "key_alice", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: time.Now().UTC()},
	})

	// generic ingest of a commit carrying the session marker
	body := `{"provider":"gitlab","kind":"commit","repo":"team/repo","branch":"feature/x","sha":"deadbeef","message":"impl X\n\nVibe-Session: sess_proj","author_email":"a@x.com"}`
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/vcs/events", bytes.NewReader([]byte(body)))
	req.Header.Set("X-Vibe-VCS-Secret", "vcs-secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ingest status %d", resp.StatusCode)
	}

	events, err := db.ListVCSEvents(ctx, store.VCSEventFilter{SessionID: "sess_proj"})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 correlated event, got %d", len(events))
	}
	e := events[0]
	if e.SessionID != "sess_proj" {
		t.Errorf("session not correlated from marker: %+v", e)
	}
	if e.APIKeyID != "key_alice" {
		t.Errorf("api key not linked via session: %+v", e)
	}
	if e.Ref != "deadbeef" {
		t.Errorf("ref/sha not stored: %+v", e)
	}
}

func TestVCSWebhookSecretEnforced(t *testing.T) {
	_, _, proxy := newVCSServer(t, "vcs-secret")
	// wrong secret → 401
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/vcs/webhook/gitlab", bytes.NewReader([]byte(`{"object_kind":"push"}`)))
	req.Header.Set("X-Gitlab-Token", "wrong")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong secret, got %d", resp.StatusCode)
	}
}

func TestVCSDisabledWithoutSecret(t *testing.T) {
	_, _, proxy := newVCSServer(t, "") // no secret configured → endpoints disabled
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/vcs/events", bytes.NewReader([]byte(`{}`)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 when VCS ingest disabled, got %d", resp.StatusCode)
	}
}

func TestVCSWebhookGitLabEndToEnd(t *testing.T) {
	_, db, proxy := newVCSServer(t, "gl-tok")
	payload, _ := json.Marshal(map[string]any{
		"object_kind": "merge_request",
		"project":     map[string]any{"path_with_namespace": "team/repo"},
		"user":        map[string]any{"name": "Bob"},
		"object_attributes": map[string]any{
			"iid": float64(99), "title": "feat [vibe:sess_gl]", "state": "opened", "source_branch": "f", "url": "http://gl/mr/99",
		},
	})
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/vcs/webhook/gitlab", bytes.NewReader(payload))
	req.Header.Set("X-Gitlab-Token", "gl-tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("gitlab webhook status %d", resp.StatusCode)
	}
	events, _ := db.ListVCSEvents(context.Background(), store.VCSEventFilter{SessionID: "sess_gl"})
	if len(events) != 1 || events[0].Kind != "merge_request" || events[0].Ref != "99" {
		t.Fatalf("gitlab MR not ingested/correlated: %+v", events)
	}
}
