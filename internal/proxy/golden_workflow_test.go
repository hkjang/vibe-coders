package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestGoldenWorkflowRun(t *testing.T) {
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

	// Create an ordered workflow: step 1 passes (expects "ok"), step 2 fails.
	resp := postJSON(t, proxy.URL+"/admin/golden-workflows", "", map[string]any{
		"name": "onboarding-suite", "description": "smoke",
		"steps": []map[string]any{
			{"name": "greet", "prompt": "say hi", "expected": "ok"},
			{"name": "summarize", "prompt": "summarize", "expected": "this-will-not-appear"},
		},
		"tags": []string{"ci"},
	})
	var created struct {
		ID    string `json:"id"`
		Steps []struct {
			Name string `json:"name"`
		} `json:"steps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if created.ID == "" || len(created.Steps) != 2 {
		t.Fatalf("workflow not created cleanly: %+v", created)
	}

	// Run with a strict gate → 1 of 2 steps pass → 422 + regression flag.
	runResp := postJSON(t, proxy.URL+"/admin/golden-workflows/run?fail_on_regression=1", "", map[string]any{
		"id": created.ID, "models": []string{"test-model"}, "min_pass_rate": 1.0,
	})
	defer runResp.Body.Close()
	if runResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on regression, got %d", runResp.StatusCode)
	}
	var out struct {
		Total     int     `json:"total"`
		Passed    int     `json:"passed"`
		Failed    int     `json:"failed"`
		PassRate  float64 `json:"pass_rate"`
		Regressed bool    `json:"regressed"`
		Failures  []struct {
			Name string `json:"name"`
		} `json:"failures"`
		Steps []map[string]any `json:"steps"`
	}
	if err := json.NewDecoder(runResp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Total != 2 || out.Passed != 1 || out.Failed != 1 {
		t.Errorf("aggregate = total %d passed %d failed %d, want 2/1/1", out.Total, out.Passed, out.Failed)
	}
	if !out.Regressed {
		t.Error("expected regressed=true")
	}
	if len(out.Failures) != 1 || out.Failures[0].Name != "summarize" {
		t.Errorf("expected 'summarize' step in failures, got %+v", out.Failures)
	}
	if len(out.Steps) != 2 {
		t.Errorf("expected 2 step results, got %d", len(out.Steps))
	}

	// Lenient gate → 200.
	ok := postJSON(t, proxy.URL+"/admin/golden-workflows/run?fail_on_regression=1", "", map[string]any{
		"id": created.ID, "models": []string{"test-model"}, "min_pass_rate": 0.5,
	})
	defer ok.Body.Close()
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with lenient gate, got %d", ok.StatusCode)
	}

	// Listing returns the workflow.
	list, err := http.Get(proxy.URL + "/admin/golden-workflows")
	if err != nil {
		t.Fatal(err)
	}
	defer list.Body.Close()
	var listed struct {
		Workflows []store.GoldenWorkflow `json:"workflows"`
	}
	if err := json.NewDecoder(list.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Workflows) != 1 {
		t.Errorf("expected 1 workflow listed, got %d", len(listed.Workflows))
	}
}
