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

func TestGoldenRunRegressionGate(t *testing.T) {
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

	// One golden prompt that will pass (expects "ok"), one that will fail.
	mk := func(name, expected string) {
		resp := postJSON(t, proxy.URL+"/admin/golden-prompts", "", map[string]any{
			"name": name, "prompt": "do the thing", "expected": expected, "tags": []string{"ci"},
		})
		resp.Body.Close()
	}
	mk("passes", "ok")
	mk("fails", "this-will-not-appear")

	// Batch run with a 100% pass-rate gate → must report a regression + 422.
	resp := postJSONQuery(t, proxy.URL+"/admin/golden-prompts/run?fail_on_regression=1", map[string]any{
		"models": []string{"test-model"}, "min_pass_rate": 1.0,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on regression, got %d", resp.StatusCode)
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
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Total != 2 || out.Passed != 1 || out.Failed != 1 {
		t.Errorf("aggregate = total %d passed %d failed %d, want 2/1/1", out.Total, out.Passed, out.Failed)
	}
	if !out.Regressed {
		t.Error("expected regressed=true")
	}
	if len(out.Failures) != 1 || out.Failures[0].Name != "fails" {
		t.Errorf("expected the 'fails' prompt in failures, got %+v", out.Failures)
	}

	// A lenient gate (50%) accepts the run → 200.
	resp2 := postJSONQuery(t, proxy.URL+"/admin/golden-prompts/run?fail_on_regression=1", map[string]any{
		"models": []string{"test-model"}, "min_pass_rate": 0.5,
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with lenient gate, got %d", resp2.StatusCode)
	}
}

func postJSONQuery(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	return postJSON(t, url, "", body)
}
