package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestText2SQLEmergencyHTTPAdmissionAndPermissions(t *testing.T) {
	var calls atomic.Int64
	entered, unblock := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(unblock) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			select {
			case <-unblock:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"SELECT dept, count(*) FROM itsm_requests GROUP BY dept"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
	}))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig(upstream.URL, "public-synthetic-upstream")
	cfg.Auth.AdminToken, cfg.Auth.AdminReadonlyToken = "public-synthetic-writer", "public-synthetic-reader"
	cfg.Text2SQL.Enabled = true
	cfg.Text2SQL.PreviewModel = "test-model"
	cfg.Text2SQL.DefaultLimit = 100
	cfg.Text2SQL.Schema = "table itsm_requests(dept text, created_at timestamp)"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal("could not initialize synthetic emergency gateway")
	}
	gateway := httptest.NewServer(server.Routes())
	defer gateway.Close()
	defer release()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	request := func(method, path, body, token string) (int, []byte) {
		req, err := http.NewRequestWithContext(ctx, method, gateway.URL+path, strings.NewReader(body))
		if err != nil {
			return 0, nil
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, nil
		}
		defer resp.Body.Close()
		payload, err := io.ReadAll(resp.Body)
		if err != nil {
			return 0, nil
		}
		return resp.StatusCode, payload
	}
	const path = "/admin/text2sql/kill-switch"
	for _, check := range []struct {
		method, token string
		want          int
	}{
		{http.MethodGet, "", 401}, {http.MethodGet, cfg.Auth.AdminReadonlyToken, 200},
		{http.MethodPost, cfg.Auth.AdminReadonlyToken, 401},
	} {
		status, _ := request(check.method, path, `{"disabled":true}`, check.token)
		if status != check.want || server.t2sKilled.Load() {
			t.Fatal("emergency read/write authorization changed")
		}
	}
	read := func() text2SQLEmergencyState {
		status, body := request(http.MethodGet, path, "", cfg.Auth.AdminToken)
		var state text2SQLEmergencyState
		if status != 200 || json.Unmarshal(body, &state) != nil || !state.ConfigEnabled {
			t.Fatal("actual emergency route state unavailable")
		}
		return state
	}
	chat := func(prompt string) (int, []byte) {
		body, _ := json.Marshal(map[string]any{"model": "vibe/text2sql-preview", "messages": []map[string]string{{"role": "user", "content": prompt}}})
		return request(http.MethodPost, "/v1/chat/completions", string(body), "")
	}
	first := make(chan int, 1)
	go func() { status, _ := chat("public synthetic admitted request"); first <- status }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("first synthetic SQL generation did not begin")
	}
	state := read()
	status, _ := request(http.MethodPost, path, reviewedText2SQLBody(true, state.ReviewToken, "public stop"), cfg.Auth.AdminToken)
	if status != 200 {
		t.Fatal("reviewed stop route failed")
	}
	status, body := chat("public synthetic request after stop")
	if status != 200 || !strings.Contains(string(body), "일시 중지") || calls.Load() != 1 {
		t.Fatal("stopped Text2SQL request reached SQL generation")
	}
	select {
	case <-first:
		t.Fatal("stopping unexpectedly cancelled admitted work")
	default:
	}
	release()
	select {
	case status := <-first:
		if status != 200 {
			t.Fatal("admitted work failed after stop")
		}
	case <-ctx.Done():
		t.Fatal("admitted work did not finish")
	}
	state = read()
	status, _ = request(http.MethodPost, path, reviewedText2SQLBody(false, state.ReviewToken, "public resume"), cfg.Auth.AdminToken)
	if status != 200 {
		t.Fatal("reviewed resume route failed")
	}
	status, _ = chat("public synthetic request after resume")
	if status != 200 || calls.Load() != 2 {
		t.Fatal("resumed Text2SQL generation did not reach the local model")
	}
}
