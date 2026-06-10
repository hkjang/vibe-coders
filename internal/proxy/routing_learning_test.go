package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestClassifyTaskType(t *testing.T) {
	mk := func(text string) []store.PromptLog { return []store.PromptLog{{Role: "user", RedactedText: text}} }
	cases := []struct{ text, want string }{
		{"이 코드를 리팩토링해줘", "refactor"},
		{"NullPointer 버그 좀 고쳐줘", "debug"},
		{"REST API 컨트롤러 만들어줘", "generate"},
		{"이 함수가 무엇을 하는지 설명해줘", "explain"},
		{"write a unit test for this", "test"},
		{"이 자바 코드를 파이썬으로 변환", "translate"},
		{"please review this PR", "review"},
		{"", "other"},
	}
	for _, c := range cases {
		if got := classifyTaskType(mk(c.text)); got != c.want {
			t.Errorf("classifyTaskType(%q) = %q, want %q", c.text, got, c.want)
		}
	}
}

func seedLearn(t *testing.T, db *store.SQLStore, taskType, model string, complexity, n, successes int, cost float64) {
	t.Helper()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < n; i++ {
		status := 200
		if i >= successes {
			status = 500
		}
		id := taskType + "-" + model + "-" + strconv.Itoa(i)
		rec := store.LogRecord{
			Request: store.RequestLog{
				ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: model, TaskType: taskType, Complexity: complexity,
				StatusCode: status, LatencyMS: 120, CreatedAt: base,
			},
			Usage: &store.TokenUsage{ID: id + "u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: base},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRoutingLearningRecommendsBestModel(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// task=refactor, complexity 80 (high bucket):
	//   cheap   = de-facto default (most used), 40 reqs, 60% success, low cost
	//   premium = fewer reqs (30) but 100% success, higher cost  → should be recommended
	//   exp     = only 5 reqs (below min_samples) → excluded from the decision
	seedLearn(t, db, "refactor", "cheap", 80, 40, 24, 10)
	seedLearn(t, db, "refactor", "premium", 80, 30, 30, 100)
	seedLearn(t, db, "refactor", "exp", 80, 5, 5, 5)

	report, err := db.RoutingLearning(ctx, time.Now().Add(-24*time.Hour), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Cells) < 3 {
		t.Fatalf("expected >=3 cells, got %d", len(report.Cells))
	}
	var rec *store.RoutingRecommendation
	for i := range report.Recommendations {
		if report.Recommendations[i].TaskType == "refactor" && report.Recommendations[i].Bucket == "high" {
			rec = &report.Recommendations[i]
			break
		}
	}
	if rec == nil {
		t.Fatalf("no recommendation for refactor/high; recs=%+v", report.Recommendations)
	}
	if rec.RecommendedModel != "premium" {
		t.Errorf("recommended = %q, want premium", rec.RecommendedModel)
	}
	if rec.TopModel != "cheap" {
		t.Errorf("top (most-used) = %q, want cheap", rec.TopModel)
	}
	if !rec.Differs {
		t.Errorf("expected recommendation to differ from de-facto default")
	}
	if rec.Confident {
		t.Errorf("expected low confidence (exp model under sample floor)")
	}
	if rec.Samples != 30 {
		t.Errorf("samples = %d, want 30", rec.Samples)
	}
	if rec.SuccessRate < 0.99 {
		t.Errorf("success rate = %.2f, want ~1.0", rec.SuccessRate)
	}
}

func TestRoutingLearningRespectsMinSamples(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	// only 5 samples total for the cell → no recommendation at min_samples=20
	seedLearn(t, db, "generate", "m1", 10, 5, 5, 10)
	report, err := db.RoutingLearning(context.Background(), time.Now().Add(-24*time.Hour), 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range report.Recommendations {
		if r.TaskType == "generate" {
			t.Fatalf("did not expect a recommendation below the sample floor: %+v", r)
		}
	}
}

func TestRoutingLearningEndpoint(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://example.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	seedLearn(t, db, "debug", "cheap", 50, 25, 15, 10)
	seedLearn(t, db, "debug", "premium", 50, 25, 25, 80)

	resp, err := http.Get(proxy.URL + "/admin/routing/learning?window=24h&min_samples=20")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var report store.RoutingLearning
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range report.Recommendations {
		if r.TaskType == "debug" && r.Bucket == "medium" {
			found = true
			if r.RecommendedModel != "premium" {
				t.Errorf("debug/medium recommended %q, want premium", r.RecommendedModel)
			}
		}
	}
	if !found {
		t.Fatalf("expected a debug/medium recommendation; got %+v", report.Recommendations)
	}
}
