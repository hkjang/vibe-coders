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
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// The environment of the work intelligence API tests.
//
// Data is real: requests go through a gateway test server to a fake provider,
// are logged by the gateway, and are classified by the worker's RunOnce. The
// only thing a test adjusts by hand is the time a logged request carries, to
// place it on an earlier day before the worker reads it.
//
// The gateway that takes the traffic runs without authentication, as every
// worker test does. The API under test is served by a second Server on the
// same database with authentication on, so the same data can be read as a
// full administrator, as an administrator who may not see raw prompts, and as
// a team-scoped administrator.

const (
	workAPIModel     = "test-model"
	workAPIMiniModel = "test-mini"
	// workAPIFailModel makes the fake provider answer 400.
	workAPIFailModel = "fail-model"
)

type workAPIEnv struct {
	*workIntelEnv
	admin  *Server
	routes http.Handler
	// Tokens of the four callers.
	full, viewer, alphaAdmin, betaAdmin string
	// insightAnswer, when set, answers an insight rewrite call.
	insightAnswer func(body string) string
	insightCalls  atomic.Int32
}

type workAPIKey struct{ id, token, team, user string }

var workAPIKeys = []workAPIKey{
	{"key-a1", "alpha-one-test-key", "alpha", "ua1"},
	{"key-a2", "alpha-two-test-key", "alpha", "ua2"},
	{"key-a3", "alpha-three-test-key", "alpha", "ua3"},
	{"key-b1", "beta-one-test-key", "beta", "ub1"},
	// A third team for the small-group tests; the other fixtures send nothing
	// with these keys.
	{"key-c1", "gamma-one-test-key", "gamma", "uc1"},
	{"key-c2", "gamma-two-test-key", "gamma", "uc2"},
	{"key-c3", "gamma-three-test-key", "gamma", "uc3"},
}

func workAPIKeyOf(t *testing.T, id string) workAPIKey {
	t.Helper()
	for _, key := range workAPIKeys {
		if key.id == id {
			return key
		}
	}
	t.Fatalf("no test key %q", id)
	return workAPIKey{}
}

func newWorkAPIEnv(t *testing.T) *workAPIEnv {
	t.Helper()
	isolateWorkIntelLogs(t)
	env := &workAPIEnv{}
	fake := &workIntelFake{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := string(raw)
		switch {
		case strings.Contains(body, workIntelInsightLLMMarker):
			env.insightCalls.Add(1)
			content := ""
			if env.insightAnswer != nil {
				content = env.insightAnswer(body)
			}
			reply, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"index": 0,
				"message": map[string]string{"role": "assistant", "content": content}, "finish_reason": "stop"}}})
			writeJSONBody(w, http.StatusOK, string(reply))
		case strings.Contains(body, `"model":"`+workAPIFailModel+`"`):
			writeJSONBody(w, http.StatusBadRequest, `{"error":{"message":"rejected by the test provider","type":"invalid_request_error"}}`)
		default:
			r.Body = io.NopCloser(bytes.NewReader(raw))
			fake.handle(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	db, raw := workIntelStores(t)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	cfg := testConfig(upstream.URL, "s")
	// Round prices, so a request's cost can be worked out by hand: 11 prompt and
	// 7 completion tokens cost 25 KRW on test-model and 12.5 KRW on test-mini.
	cfg.Pricing = map[string]config.ModelPrice{
		workAPIModel:     {InputKRWPer1M: 1_000_000, OutputKRWPer1M: 2_000_000},
		workAPIMiniModel: {InputKRWPer1M: 500_000, OutputKRWPer1M: 1_000_000},
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	env.workIntelEnv = &workIntelEnv{captureEnv: &captureEnv{url: gateway.URL, db: db, server: server}, raw: raw, fake: fake}
	ctx := context.Background()
	for _, key := range workAPIKeys {
		if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{ID: key.id, Name: key.id, KeyHash: hashProxyKey(key.token), Team: key.team, UserID: key.user, Status: "active"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, team := range []store.AuthTeam{{ID: "team-alpha-id", Name: "alpha"}, {ID: "team-beta-id", Name: "beta"}, {ID: "team-gamma-id", Name: "gamma"}} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	env.worker = NewWorkIntelWorker(server)
	t.Cleanup(env.worker.Stop)

	adminCfg := cfg
	adminCfg.Auth.Enabled, adminCfg.Auth.JWTSecret, adminCfg.Auth.AccessTokenTTL = true, "work-intel-api-fixture-jwt", time.Hour
	env.admin, err = NewServer(adminCfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	env.routes = env.admin.Routes()
	now := time.Now().UTC().Add(-time.Minute)
	token := func(subject, role, team string, scopes ...string) string {
		sessionID := subject + "-session"
		if err := db.InsertAuthSession(ctx, sessionID, subject, "127.0.0.1", "test", now.Add(2*time.Hour)); err != nil {
			t.Fatal(err)
		}
		signed, err := env.admin.signAccessToken(accessClaims{Subject: subject, Role: role, TeamID: team, Scopes: scopes, SessionID: sessionID,
			Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(2 * time.Hour).Unix()})
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	env.full = token("wi-full-admin", "super_admin", "", "admin:read", "admin:write")
	env.viewer = token("wi-viewer", "readonly_admin", "", "admin:read")
	env.alphaAdmin = token("wi-alpha-admin", "team_admin", "team-alpha-id", "admin:read", "admin:write")
	env.betaAdmin = token("wi-beta-admin", "team_admin", "team-beta-id", "admin:read", "admin:write")
	return env
}

// send posts one chat request as a key and returns the id the gateway logged
// it under.
func (e *workAPIEnv) send(t *testing.T, keyID, session, model, prompt string) string {
	t.Helper()
	key := workAPIKeyOf(t, keyID)
	resp, body := e.post(t, "/v1/chat/completions", map[string]any{
		"model": model, "messages": []map[string]string{{"role": "user", "content": prompt}},
	}, "Authorization", "Bearer "+key.token, "X-Session-ID", session, "User-Agent", "claude-cli/2.1")
	if model == workAPIFailModel {
		if resp.StatusCode < 400 {
			t.Fatalf("the failing model answered %d", resp.StatusCode)
		}
	} else if resp.StatusCode != http.StatusOK {
		t.Fatalf("chat request = %d %s", resp.StatusCode, body)
	}
	e.sent++
	e.waitLogged(t, e.sent)
	// The response names the trace; the request id is looked up by it, which
	// does not depend on how two timestamps sort.
	trace := resp.Header.Get("X-Request-ID")
	if trace == "" {
		t.Fatal("the gateway response carries no X-Request-ID")
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var id string
		err := e.raw.QueryRowContext(context.Background(), workAPIBind(`SELECT id FROM request_logs WHERE trace_id = ?`), trace).Scan(&id)
		if err == nil {
			return id
		}
		if time.Now().After(deadline) {
			t.Fatalf("request with trace %s was not logged: %v", trace, err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// bind writes a statement's placeholders for the database of the test.
func workAPIBind(query string) string {
	if os.Getenv("TEST_POSTGRES_DSN") == "" {
		return query
	}
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			b.WriteString("$" + strconv.Itoa(n))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func (e *workAPIEnv) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := e.raw.ExecContext(context.Background(), workAPIBind(query), args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// backdate moves logged requests that the worker has not read yet to the same
// time of day, days earlier.
func (e *workAPIEnv) backdate(t *testing.T, days int, ids ...string) {
	t.Helper()
	at := time.Now().AddDate(0, 0, -days).UTC()
	for i, id := range ids {
		// A millisecond apart, in the order given, so "newest first" is defined.
		e.exec(t, `UPDATE request_logs SET created_at = ? WHERE id = ?`, at.Add(time.Duration(i)*time.Millisecond).Format(time.RFC3339Nano), id)
	}
}

func (e *workAPIEnv) feedback(t *testing.T, requestID string, rating int) {
	t.Helper()
	if err := e.db.InsertLLMFeedback(context.Background(), store.LLMFeedback{ID: "fb-" + requestID + "-" + strconv.Itoa(rating), RequestID: requestID,
		TraceID: "trace-" + requestID, Rating: rating, Label: "test", Source: "test", CreatedBy: "tester", CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
}

// call sends a request to the API as the holder of token and returns the
// status and the body.
func (e *workAPIEnv) call(t *testing.T, token, method, path string, body any) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	r := httptest.NewRequest(method, workIntelAdminPath+path, reader)
	r.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	e.routes.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func newWorkAPIRequest(method, path, token string) *http.Request {
	r := httptest.NewRequest(method, workIntelAdminPath+path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	return r
}

// newWorkAPIRecorder serves a request and returns the recorder, for tests
// that look at response headers.
func newWorkAPIRecorder(e interface{ handler() http.Handler }, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	e.handler().ServeHTTP(w, r)
	return w
}

func (e *workAPIEnv) handler() http.Handler { return e.routes }

// get reads a JSON resource and fails the test unless it answers 200.
func (e *workAPIEnv) get(t *testing.T, token, path string, into any) {
	t.Helper()
	status, body := e.call(t, token, http.MethodGet, path, nil)
	if status != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, status, body)
	}
	if err := json.Unmarshal(body, into); err != nil {
		t.Fatalf("GET %s: %v\n%s", path, err, body)
	}
}

// do sends a body and decodes a 2xx answer.
func (e *workAPIEnv) do(t *testing.T, token, method, path string, body, into any) {
	t.Helper()
	status, raw := e.call(t, token, method, path, body)
	if status < 200 || status > 299 {
		t.Fatalf("%s %s = %d %s", method, path, status, raw)
	}
	if into != nil {
		if err := json.Unmarshal(raw, into); err != nil {
			t.Fatalf("%s %s: %v\n%s", method, path, err, raw)
		}
	}
}

// errorCode returns the error code of a response body.
func workAPIErrorCode(body []byte) string {
	var parsed struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &parsed)
	return parsed.Error.Code
}

func workAPIToday() string { return store.WorkIntelDay(time.Now()) }

func workAPIDay(offset int) string { return workIntelShiftDay(workAPIToday(), offset) }

func decode(t *testing.T, body []byte, into any) {
	t.Helper()
	if err := json.Unmarshal(body, into); err != nil {
		t.Fatalf("%v\n%s", err, body)
	}
}
