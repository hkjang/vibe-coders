package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func jsonReader(v any) *bytes.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func TestComplexityRoutingRewritesModel(t *testing.T) {
	var seenModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var root map[string]any
		_ = json.Unmarshal(body, &root)
		seenModel, _ = root["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`))
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

	// rule: any model, complexity 0-34 → cheap-mini
	resp := postJSON(t, proxy.URL+"/admin/routing-rules", "", map[string]any{
		"match_pattern": "*", "min_complexity": 0, "max_complexity": 34,
		"target_model": "cheap-mini", "priority": 10,
	})
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("rule create failed: %d %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	// a tiny prompt → low complexity → should be downgraded to cheap-mini
	out := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "gpt-premium",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if out.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(out.Body)
		t.Fatalf("expected 200, got %d: %s", out.StatusCode, body)
	}
	if out.Header.Get("X-Routed-Model") != "cheap-mini" {
		t.Fatalf("expected X-Routed-Model=cheap-mini, got %q", out.Header.Get("X-Routed-Model"))
	}
	out.Body.Close()
	if seenModel != "cheap-mini" {
		t.Fatalf("upstream should have received rewritten model cheap-mini, got %q", seenModel)
	}

	waitFor(t, time.Second, func() bool {
		s, _ := db.Summary(context.Background())
		return s.TotalRequests == 1
	})
	recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	id := recent[0].ID

	// explain should show model_changed gpt-premium → cheap-mini, reason complexity_rule
	exResp, err := http.Get(proxy.URL + "/admin/requests/" + id + "/explain")
	if err != nil {
		t.Fatal(err)
	}
	defer exResp.Body.Close()
	var ex struct {
		Routing map[string]any `json:"routing"`
	}
	if err := json.NewDecoder(exResp.Body).Decode(&ex); err != nil {
		t.Fatal(err)
	}
	if ex.Routing["reason"] != "complexity_rule" {
		t.Errorf("expected complexity_rule, got %v", ex.Routing["reason"])
	}
	if ex.Routing["model_changed"] != true {
		t.Errorf("expected model_changed=true, got %v", ex.Routing["model_changed"])
	}
	if ex.Routing["requested_model"] != "gpt-premium" {
		t.Errorf("expected requested_model gpt-premium, got %v", ex.Routing["requested_model"])
	}
	if ex.Routing["chosen_model"] != "cheap-mini" {
		t.Errorf("expected chosen_model cheap-mini, got %v", ex.Routing["chosen_model"])
	}
}

func TestComplexityRoutingRespectsPinAndRange(t *testing.T) {
	var seenModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var root map[string]any
		_ = json.Unmarshal(body, &root)
		seenModel, _ = root["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
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

	// rule only for complexity 80-100 → won't match a tiny prompt
	postJSON(t, proxy.URL+"/admin/routing-rules", "", map[string]any{
		"match_pattern": "*", "min_complexity": 80, "max_complexity": 100, "target_model": "huge", "priority": 10,
	}).Body.Close()

	out := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "gpt-orig", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	out.Body.Close()
	if seenModel != "gpt-orig" {
		t.Fatalf("low-complexity request should NOT match 80-100 rule; got model %q", seenModel)
	}

	// X-Proxy-No-Route header disables routing even if a matching rule exists
	postJSON(t, proxy.URL+"/admin/routing-rules", "", map[string]any{
		"match_pattern": "*", "min_complexity": 0, "max_complexity": 100, "target_model": "forced", "priority": 5,
	}).Body.Close()
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", jsonReader(map[string]any{
		"model": "gpt-orig2", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Proxy-No-Route", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if seenModel != "gpt-orig2" {
		t.Fatalf("X-Proxy-No-Route should bypass routing; got model %q", seenModel)
	}
}
