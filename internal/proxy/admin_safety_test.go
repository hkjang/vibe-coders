package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestKillSwitchBlocksV1Calls(t *testing.T) {
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

	ok := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if ok.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(ok.Body)
		t.Fatalf("expected 200 before kill, got %d: %s", ok.StatusCode, body)
	}
	ok.Body.Close()

	flip := postJSON(t, proxy.URL+"/admin/kill-switch", "", map[string]any{"disabled": true, "reason": "test"})
	if flip.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(flip.Body)
		t.Fatalf("kill switch on failed: %d %s", flip.StatusCode, body)
	}
	flip.Body.Close()

	blocked := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if blocked.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 after kill switch, got %d", blocked.StatusCode)
	}
	if blocked.Header.Get("X-Kill-Switch") == "" {
		t.Fatal("expected X-Kill-Switch header")
	}
	blocked.Body.Close()

	resume := postJSON(t, proxy.URL+"/admin/kill-switch", "", map[string]any{"disabled": false})
	if resume.StatusCode != http.StatusOK {
		t.Fatalf("resume failed: %d", resume.StatusCode)
	}
	resume.Body.Close()

	post := postJSON(t, proxy.URL+"/v1/chat/completions", "", chatBody("test-model", false))
	if post.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(post.Body)
		t.Fatalf("expected 200 after resume, got %d: %s", post.StatusCode, body)
	}
	post.Body.Close()
}

func TestReadonlyAdminTokenAllowsOnlyGET(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig("http://example.invalid", "secret")
	cfg.Auth.AdminToken = "rw-secret"
	cfg.Auth.AdminReadonlyToken = "ro-secret"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	get := func(token string) int {
		req, _ := http.NewRequest(http.MethodGet, proxy.URL+"/admin/stats", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if c := get("ro-secret"); c != http.StatusOK {
		t.Fatalf("readonly GET /admin/stats should be 200, got %d", c)
	}
	if c := get(""); c != http.StatusUnauthorized {
		t.Fatalf("no token GET should be 401, got %d", c)
	}

	// readonly cannot create a key
	req, _ := http.NewRequest(http.MethodPost, proxy.URL+"/admin/api-keys", nil)
	req.Header.Set("Authorization", "Bearer ro-secret")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("readonly POST should be 401, got %d", resp.StatusCode)
	}
}

func TestAlertWorkerFiresAndPostsWebhook(t *testing.T) {
	var hookHits atomic.Int32
	var lastBody atomic.Value // string
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		lastBody.Store(string(body))
		hookHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer webhook.Close()

	db := openTestStore(t)
	defer db.Close()

	// seed three requests right now so MetricSince returns >0 requests for the window
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		err := db.InsertLogRecord(context.Background(), store.LogRecord{
			Request: store.RequestLog{
				ID: "req-" + string(rune('a'+i)), TraceID: "trace", Endpoint: "/v1/chat/completions",
				StatusCode: 200, CreatedAt: now,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	// rule: fire when requests >= 2 in the last 5 minutes
	err := db.UpsertAlertRule(context.Background(), store.AlertRule{
		ID: "alert-1", Name: "burst", Metric: "requests", WindowSeconds: 300,
		Threshold: 2, Scope: "global", ScopeValue: "*", WebhookURL: webhook.URL, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	worker := NewAlertWorker(db, &Metrics{}, time.Second)
	// Don't Start() to avoid timer; just call evaluate directly.
	worker.evaluate()

	if hookHits.Load() == 0 {
		t.Fatal("expected webhook to be hit")
	}
	bodyStr, _ := lastBody.Load().(string)
	var payload map[string]any
	if err := json.Unmarshal([]byte(bodyStr), &payload); err != nil {
		t.Fatalf("webhook body not JSON: %v", err)
	}
	if payload["rule"] != "burst" {
		t.Fatalf("unexpected webhook payload rule: %v", payload)
	}

	events, err := db.ListAlertEvents(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || !events[0].Delivered {
		t.Fatalf("expected delivered event, got %#v", events)
	}
}

func TestAlertWorkerFiresOnFirstChunkP95(t *testing.T) {
	var hookHits atomic.Int32
	var lastBody atomic.Value // string
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		lastBody.Store(string(body))
		hookHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer webhook.Close()

	db := openTestStore(t)
	defer db.Close()

	now := time.Now().UTC()
	for i := 0; i < 20; i++ {
		err := db.InsertLogRecord(context.Background(), store.LogRecord{
			Request: store.RequestLog{
				ID:           fmt.Sprintf("req-latency-%02d", i),
				TraceID:      "trace-latency",
				Endpoint:     "/v1/chat/completions",
				StatusCode:   200,
				LatencyMS:    int64((i + 1) * 20),
				FirstChunkMS: int64((i + 1) * 10),
				CreatedAt:    now,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	snapshot, err := db.MetricSince(context.Background(), "global", "*", now.Add(-5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.FirstChunkP95MS < 180 {
		t.Fatalf("expected first chunk p95 to be high enough, got %#v", snapshot)
	}

	err = db.UpsertAlertRule(context.Background(), store.AlertRule{
		ID: "alert-latency", Name: "slow first chunk", Metric: "first_chunk_p95_ms", WindowSeconds: 300,
		Threshold: 180, Scope: "global", ScopeValue: "*", WebhookURL: webhook.URL, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	worker := NewAlertWorker(db, &Metrics{}, time.Second)
	worker.evaluate()

	if hookHits.Load() == 0 {
		t.Fatal("expected latency webhook to be hit")
	}
	bodyStr, _ := lastBody.Load().(string)
	var payload map[string]any
	if err := json.Unmarshal([]byte(bodyStr), &payload); err != nil {
		t.Fatalf("webhook body not JSON: %v", err)
	}
	if payload["metric"] != "first_chunk_p95_ms" {
		t.Fatalf("unexpected webhook metric: %v", payload)
	}

	events, err := db.ListAlertEvents(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Metric != "first_chunk_p95_ms" {
		t.Fatalf("expected latency alert event, got %#v", events)
	}
}

func TestAlertWorkerFiresOnLLMEvaluationFailureRate(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()

	now := time.Now().UTC()
	err := db.InsertLogRecord(context.Background(), store.LogRecord{
		Request: store.RequestLog{
			ID:         "req-llm-eval",
			TraceID:    "trace-llm-eval",
			Endpoint:   "/v1/chat/completions",
			StatusCode: 200,
			CreatedAt:  now,
		},
		Evaluations: []store.LLMEvaluation{
			{
				ID: "eval-pass", RequestID: "req-llm-eval", TraceID: "trace-llm-eval",
				Name: "quality", Category: "quality", Evaluator: "test", Score: 1,
				Label: "pass", Passed: true, CreatedAt: now,
			},
			{
				ID: "eval-fail", RequestID: "req-llm-eval", TraceID: "trace-llm-eval",
				Name: "safety", Category: "safety", Evaluator: "test", Score: 0,
				Label: "fail", Passed: false, Reason: "test failure", CreatedAt: now,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := db.MetricSince(context.Background(), "global", "*", now.Add(-5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.LLMEvaluations != 2 || snapshot.LLMEvalFailures != 1 {
		t.Fatalf("unexpected llm eval snapshot: %#v", snapshot)
	}

	err = db.UpsertAlertRule(context.Background(), store.AlertRule{
		ID: "alert-llm-eval-rate", Name: "llm eval failure rate",
		Metric: "llm_eval_failure_rate", WindowSeconds: 300, Threshold: 0.5,
		Scope: "global", ScopeValue: "*", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	worker := NewAlertWorker(db, &Metrics{}, time.Second)
	worker.evaluate()

	events, err := db.ListAlertEvents(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Metric != "llm_eval_failure_rate" {
		t.Fatalf("expected llm eval failure alert event, got %#v", events)
	}
}
