package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestRequestReplayHitsUpstreamAgain(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Logging.RawBodies = true
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	r := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if r.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(r.Body)
		t.Fatalf("call failed: %d %s", r.StatusCode, body)
	}
	r.Body.Close()
	if hits.Load() != 1 {
		t.Fatalf("expected 1 upstream hit, got %d", hits.Load())
	}

	waitFor(t, time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 1
	})

	listResp, err := http.Get(proxy.URL + "/admin/requests?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	var list struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	id := list.Requests[0].ID

	replayResp, err := http.NewRequest(http.MethodPost, proxy.URL+"/admin/requests/"+id+"/replay", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(replayResp)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("replay failed: %d %s", resp.StatusCode, body)
	}
	if hits.Load() != 2 {
		t.Fatalf("expected upstream re-hit, got total %d", hits.Load())
	}
	if resp.Header.Get("X-Replay-Of") != id {
		t.Fatalf("expected X-Replay-Of=%s, got %s", id, resp.Header.Get("X-Replay-Of"))
	}
}

func TestReplayRefusesWhenBodyNotStored(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	// Insert a row with empty body_raw and cleared body content
	err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{
			ID: "req-noraw", TraceID: "trace", Endpoint: "/v1/chat/completions",
			StatusCode: 200, CreatedAt: time.Now().UTC(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/admin/requests/req-noraw/replay", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing body, got %d", resp.StatusCode)
	}
}

func TestDiffAndSuggest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, m := range []string{"test-model", "test-model"} {
		r := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody(m, false))
		if r.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(r.Body)
			t.Fatalf("call failed: %d %s", r.StatusCode, body)
		}
		r.Body.Close()
	}
	waitFor(t, time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 2
	})

	listResp, err := http.Get(proxy.URL + "/admin/requests?limit=5")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	var list struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Requests) < 2 {
		t.Fatalf("expected 2 requests, got %d", len(list.Requests))
	}
	a, b := list.Requests[0].ID, list.Requests[1].ID

	diffResp, err := http.Get(proxy.URL + "/admin/requests/diff?a=" + a + "&b=" + b)
	if err != nil {
		t.Fatal(err)
	}
	defer diffResp.Body.Close()
	if diffResp.StatusCode != http.StatusOK {
		t.Fatalf("diff failed: %d", diffResp.StatusCode)
	}
	var diff struct {
		Left  store.RequestDetail `json:"left"`
		Right store.RequestDetail `json:"right"`
	}
	if err := json.NewDecoder(diffResp.Body).Decode(&diff); err != nil {
		t.Fatal(err)
	}
	if diff.Left.Request.ID != a || diff.Right.Request.ID != b {
		t.Fatalf("unexpected diff ids: left=%s right=%s", diff.Left.Request.ID, diff.Right.Request.ID)
	}

	sugResp, err := http.Get(proxy.URL + "/admin/suggest?field=model")
	if err != nil {
		t.Fatal(err)
	}
	defer sugResp.Body.Close()
	var sug struct {
		Field  string   `json:"field"`
		Values []string `json:"values"`
	}
	if err := json.NewDecoder(sugResp.Body).Decode(&sug); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, v := range sug.Values {
		if strings.EqualFold(v, "test-model") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected test-model in suggestions, got %#v", sug.Values)
	}
}
