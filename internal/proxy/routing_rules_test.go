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

// A routing rule decides which model live traffic reaches. Editing one used to be
// impossible: the update accepted only "enabled", so changing a pattern or target
// meant deleting the rule and creating a new one, and traffic routed differently
// for as long as the rule was gone.
func TestRoutingRuleUpdateEditsEveryFieldAndValidatesTheMergedRule(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	created := postJSON(t, proxy.URL+"/admin/routing-rules", "", map[string]any{
		"match_pattern": "gpt-*", "min_complexity": 0, "max_complexity": 40,
		"target_model": "cheap-mini", "target_provider": "openai", "priority": 10, "note": "first",
	})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d", created.StatusCode)
	}
	var createdBody struct {
		Rule store.RoutingRule `json:"rule"`
	}
	if err := json.NewDecoder(created.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	id := createdBody.Rule.ID

	patch := func(t *testing.T, body map[string]any) (*http.Response, store.RoutingRule) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPatch, proxy.URL+"/admin/routing-rules/"+id, jsonReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out struct {
			Rule store.RoutingRule `json:"rule"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp, out.Rule
	}

	resp, rule := patch(t, map[string]any{
		"match_pattern": "claude-*", "target_model": "balanced", "target_provider": "anthropic",
		"priority": 5, "min_complexity": 10, "max_complexity": 90, "note": "second",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("full update status = %d", resp.StatusCode)
	}
	want := store.RoutingRule{
		ID: id, Enabled: true, Priority: 5, MatchPattern: "claude-*",
		MinComplexity: 10, MaxComplexity: 90, TargetModel: "balanced",
		TargetProvider: "anthropic", Note: "second",
	}
	rule.CreatedAt = want.CreatedAt
	if rule != want {
		t.Fatalf("updated rule = %+v, want %+v", rule, want)
	}

	// An absent field keeps its stored value.
	if resp, rule = patch(t, map[string]any{"enabled": false}); resp.StatusCode != http.StatusOK ||
		rule.Enabled || rule.MatchPattern != "claude-*" || rule.TargetModel != "balanced" || rule.Priority != 5 {
		t.Fatalf("partial update lost stored fields: status=%d rule=%+v", resp.StatusCode, rule)
	}

	// Validation runs on the merged rule, so moving one bound past the other fails.
	if resp, _ = patch(t, map[string]any{"min_complexity": 95}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("impossible merged range status = %d, want 400", resp.StatusCode)
	}
	if resp, _ = patch(t, map[string]any{"target_model": "   "}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank target model status = %d, want 400", resp.StatusCode)
	}
	if resp, _ = patch(t, map[string]any{"priority": 0}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-positive priority status = %d, want 400", resp.StatusCode)
	}

	// A rejected patch must not have changed the stored rule.
	rules, err := db.ListRoutingRules(context.Background())
	if err != nil || len(rules) != 1 {
		t.Fatalf("stored rules = %d err=%v", len(rules), err)
	}
	if rules[0].MinComplexity != 10 || rules[0].MaxComplexity != 90 || rules[0].TargetModel != "balanced" {
		t.Fatalf("rejected patch changed the stored rule: %+v", rules[0])
	}
}
