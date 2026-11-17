package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func readSessionPage(t *testing.T, base, token, query string, status int) []byte {
	t.Helper()
	req, err := http.NewRequest("GET", base+"/admin/sessions/page"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != status || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d want=%d cache=%s", res.StatusCode, status, res.Header.Get("Cache-Control"))
	}
	return body
}
func TestSessionPageProjectionValidationAndLegacy(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "session-page-admin")
	now := time.Now().UTC().Add(-time.Minute)
	for i, id := range []string{"session-ordinary", "person@example.com"} {
		rid := []string{"r1", "r2"}[i]
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: rid, SessionID: id, StatusCode: 200, CreatedAt: now}, Prompts: []store.PromptLog{{ID: rid + "p", RequestID: rid, Role: "user", RedactedText: "질문 person@example.com", CreatedAt: now}}}); err != nil {
			t.Fatal(err)
		}
	}
	body := readSessionPage(t, gateway.URL, "session-page-admin", "", 200)
	if strings.Contains(string(body), "person@example.com") {
		t.Fatal("PII exposed")
	}
	var page sessionPageResponse
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Version != 1 || page.Summary.Sessions != 2 || page.Summary.Requests != 2 || len(page.Sessions) != 2 {
		t.Fatal(page)
	}
	unsafe := 0
	for _, row := range page.Sessions {
		if row.SessionID == nil {
			unsafe++
		}
		if len(row.RowKey) != 51 {
			t.Fatal("row key", row.RowKey)
		}
	}
	if unsafe != 1 {
		t.Fatal("unsafe ID exposed")
	}
	keys := map[string]string{}
	for _, row := range page.Sessions {
		if row.SessionID != nil {
			keys[*row.SessionID] = row.RowKey
		}
	}
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: "newest-request", SessionID: "newest-session", CreatedAt: now.Add(time.Second), StatusCode: 200}}); err != nil {
		t.Fatal(err)
	}
	var refreshed sessionPageResponse
	if err := json.Unmarshal(readSessionPage(t, gateway.URL, "session-page-admin", "", 200), &refreshed); err != nil {
		t.Fatal(err)
	}
	for _, row := range refreshed.Sessions {
		if row.SessionID != nil && keys[*row.SessionID] != "" && row.RowKey != keys[*row.SessionID] {
			t.Fatal("new request changed existing session identity")
		}
	}
	for _, q := range []string{"?days=0", "?days=366", "?days=01", "?days=7&days=7", "?limit=26", "?offset=1", "?offset=1000001", "?offset=000", "?q=%ZZ", "?q=x;y", "?q=person%40example.com", "?q=" + strings.Repeat("x", 257), "?search=any", "?q=a&q=b"} {
		readSessionPage(t, gateway.URL, "session-page-admin", q, 400)
	}
	readSessionPage(t, gateway.URL, "", "", 401)
	readSessionPage(t, gateway.URL, "session-page-admin", "?q=ordinary", 200)
	for _, method := range []string{"POST", "HEAD", "DELETE"} {
		req, _ := http.NewRequest(method, gateway.URL+"/admin/sessions/page", nil)
		req.Header.Set("Authorization", "Bearer session-page-admin")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 405 || res.Header.Get("Allow") != "GET" {
			t.Fatal(method, res.StatusCode)
		}
	}
	req, _ := http.NewRequest("GET", gateway.URL+"/admin/sessions", nil)
	req.Header.Set("Authorization", "Bearer session-page-admin")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var legacy map[string]json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&legacy); err != nil {
		t.Fatal(err)
	}
	if _, ok := legacy["session_page_version"]; ok || legacy["sessions"] == nil || legacy["note"] == nil {
		t.Fatal("legacy changed")
	}
}
func TestSessionPageTeamAuthorization(t *testing.T) {
	db := openTestStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Add(-time.Minute)
	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: "team-a", Name: "개발팀"}); err != nil {
		t.Fatal(err)
	}
	for _, key := range []store.APIKeyRecord{{ID: "ka", Team: "개발팀", KeyHash: "hash-a"}, {ID: "kb", Team: "team-b", KeyHash: "hash-b"}} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct{ id, key, message string }{{"ra", "ka", "내 질문"}, {"rb", "kb", "다른 팀 질문"}} {
		if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{ID: row.id, APIKeyID: row.key, SessionID: "shared-session", CreatedAt: now, StatusCode: 200}, Prompts: []store.PromptLog{{ID: row.id + "p", RequestID: row.id, Role: "user", RedactedText: row.message, CreatedAt: now}}}); err != nil {
			t.Fatal(err)
		}
	}
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "sessions.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://upstream.invalid", "")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "session-page-fixture"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	token := issueLLMScopedTestToken(t, db, server, "owner", "team_admin", "team-a", []string{"admin:read"}, now)
	body := readSessionPage(t, gateway.URL, token, "", 200)
	var page sessionPageResponse
	_ = json.Unmarshal(body, &page)
	if page.Summary.Requests != 1 || page.Summary.Sessions != 1 || len(page.Sessions) != 1 || page.Sessions[0].LastMessage != "내 질문" || strings.Contains(string(body), "다른 팀") {
		t.Fatal("scope violation")
	}
	empty := issueLLMScopedTestToken(t, db, server, "empty", "team_admin", "", []string{"admin:read"}, now)
	body = readSessionPage(t, gateway.URL, empty, "", 200)
	_ = json.Unmarshal(body, &page)
	if page.Summary.Sessions != 0 || len(page.Sessions) != 0 {
		t.Fatal("empty scope widened")
	}
	denied := issueLLMScopedTestToken(t, db, server, "denied", "member", "team-a", nil, now)
	readSessionPage(t, gateway.URL, denied, "", 401)
}
