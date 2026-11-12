package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

type goldenReviewedFixture struct {
	*apiKeyScopeContractFixture
	server *Server
	reader string
	mu     sync.Mutex
	bodies []map[string]any
	onCall func(context.Context)
}

func newGoldenReviewedFixture(t *testing.T) *goldenReviewedFixture {
	t.Helper()
	f := &goldenReviewedFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("upstream received invalid JSON")
		}
		f.mu.Lock()
		f.bodies = append(f.bodies, body)
		f.mu.Unlock()
		if f.onCall != nil {
			f.onCall(r.Context())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"public answer"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`))
	}))
	t.Cleanup(upstream.Close)
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	now := time.Now().UTC()
	f.adminToken = issueLLMScopedTestToken(t, f.db, f.server, "golden-run-writer", "model_operator", "", []string{"admin:read", "admin:write"}, now)
	f.reader = issueLLMScopedTestToken(t, f.db, f.server, "golden-run-reader", "readonly_admin", "", []string{"admin:read"}, now)
	for _, p := range []store.GoldenPrompt{
		{ID: "golden_public_a", Name: "첫 검사", Prompt: "public first question", Expected: "public answer", Tags: []string{"public"}},
		{ID: "golden_public_b", Name: "둘째 검사", Prompt: `{"messages":[{"role":"user","content":"public second question"}],"n":5,"max_tokens":9000,"max_completion_tokens":10000}`, Expected: "missing answer"},
	} {
		if err := f.db.UpsertGoldenPrompt(t.Context(), p); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.db.UpsertGoldenWorkflow(t.Context(), store.GoldenWorkflow{ID: "gwf_public", Name: "공개 검사", Steps: []store.GoldenWorkflowStep{
		{Name: "첫 단계", Prompt: "public first step", Expected: "public answer"},
		{Name: "둘째 단계", Prompt: "public second step", Expected: "missing answer"},
	}}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *goldenReviewedFixture) revisions(t *testing.T, workflow bool) map[string]string {
	t.Helper()
	path := "/admin/golden-prompts"
	if workflow {
		path = "/admin/golden-workflows"
	}
	var response struct {
		Revisions map[string]string `json:"run_revisions"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, path, f.reader, "", http.StatusOK), &response) != nil || len(response.Revisions) == 0 {
		t.Fatal("GET must expose exact definition review hashes")
	}
	for _, rev := range response.Revisions {
		if len(rev) != 64 {
			t.Fatal("invalid revision")
		}
	}
	return response.Revisions
}

func goldenRunBody(t *testing.T, fields map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestGoldenReviewedRunSelectionLimitsResultsAndAuth(t *testing.T) {
	f := newGoldenReviewedFixture(t)
	revs := f.revisions(t, false)
	body := goldenRunBody(t, map[string]any{"models": []string{" public-model-a ", "public-model-b", "public-model-a"}, "prompt_ids": []string{"golden_public_b"}, "min_pass_rate": 1,
		"review": goldenRunReview{Definitions: map[string]string{"golden_public_b": revs["golden_public_b"]}, MaxCalls: 2, MaxOutputTokens: 128}})
	f.request(t, http.MethodPost, "/admin/golden-prompts/run", f.reader, body, http.StatusUnauthorized)
	f.mu.Lock()
	deniedCalls := len(f.bodies)
	f.mu.Unlock()
	if deniedCalls != 0 {
		t.Fatal("read-only caller executed models")
	}
	var result struct {
		Total    int                        `json:"total"`
		Failed   int                        `json:"failed"`
		Planned  int                        `json:"planned_total"`
		Complete bool                       `json:"complete"`
		Limit    int                        `json:"max_output_tokens"`
		Results  []store.GoldenPromptResult `json:"results"`
	}
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/golden-prompts/run?fail_on_regression=1", f.adminToken, body, http.StatusUnprocessableEntity), &result) != nil {
		t.Fatal("invalid run result")
	}
	if result.Total != 2 || result.Failed != 2 || result.Planned != 2 || !result.Complete || result.Limit != 128 || len(result.Results) != 2 {
		t.Fatal("selection/normalization/gate result differs")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) != 2 {
		t.Fatal("must execute only selected prompt across normalized models")
	}
	for _, request := range f.bodies {
		if request["max_completion_tokens"] != float64(128) || request["max_tokens"] != nil || request["n"] != float64(1) || request["stream"] != false {
			t.Fatal("reviewed generation limits not forwarded")
		}
	}
	for _, row := range result.Results {
		if row.PromptID != "golden_public_b" || row.Passed {
			t.Fatal("unexpected result identity or gate")
		}
	}
	stored, err := f.db.ListGoldenPromptResults(t.Context(), "golden_public_b", 50)
	if err != nil || len(stored) != 2 {
		t.Fatal("existing prompt result persistence missing")
	}
	audits, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil || len(audits) != 1 || audits[0].Action != "governance.golden.run" {
		t.Fatal("existing execution audit missing")
	}
}

func TestGoldenReviewedRunRejectsChangedDefinitionsAndInvalidBoundsBeforeCalls(t *testing.T) {
	f := newGoldenReviewedFixture(t)
	revs := f.revisions(t, false)
	for _, tc := range []struct {
		name             string
		maxCalls, tokens int
		rate             float64
	}{
		{"too few calls", 1, 128, 1}, {"too many calls", 65, 128, 1}, {"no calls", 0, 128, 1}, {"no output", 2, 0, 1}, {"too much output", 2, 4097, 1}, {"negative rate", 2, 128, -.1}, {"large rate", 2, 128, 1.1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := goldenRunBody(t, map[string]any{"models": []string{"public-model"}, "min_pass_rate": tc.rate, "review": goldenRunReview{Definitions: revs, MaxCalls: tc.maxCalls, MaxOutputTokens: tc.tokens}})
			f.request(t, http.MethodPost, "/admin/golden-prompts/run", f.adminToken, body, http.StatusBadRequest)
		})
	}
	body := goldenRunBody(t, map[string]any{"models": []string{"public-model"}, "review": goldenRunReview{Definitions: revs, MaxCalls: 2, MaxOutputTokens: 128}})
	if err := f.db.UpsertGoldenPrompt(t.Context(), store.GoldenPrompt{ID: "golden_public_a", Name: "변경된 검사", Prompt: "changed public question"}); err != nil {
		t.Fatal(err)
	}
	f.request(t, http.MethodPost, "/admin/golden-prompts/run", f.adminToken, body, http.StatusConflict)
	for _, ids := range [][]string{{"missing"}, {"golden_public_a", "golden_public_a"}} {
		status := http.StatusConflict
		if len(ids) == 2 {
			status = http.StatusBadRequest
		}
		f.request(t, http.MethodPost, "/admin/golden-prompts/run", f.adminToken, goldenRunBody(t, map[string]any{"models": []string{"public-model"}, "prompt_ids": ids}), status)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) != 0 {
		t.Fatal("rejected reviews must not invoke a model")
	}
}

func TestGoldenReviewedWorkflowUsesReviewedSnapshotAndOutputLimit(t *testing.T) {
	f := newGoldenReviewedFixture(t)
	revs := f.revisions(t, true)
	var once sync.Once
	f.onCall = func(context.Context) {
		once.Do(func() {
			if err := f.db.UpsertGoldenWorkflow(context.Background(), store.GoldenWorkflow{ID: "gwf_public", Name: "later edit", Steps: []store.GoldenWorkflowStep{{Prompt: "later prompt"}}}); err != nil {
				t.Error(err)
			}
		})
	}
	body := goldenRunBody(t, map[string]any{"id": "gwf_public", "models": []string{"public-model"}, "min_pass_rate": .5, "review": goldenRunReview{Definitions: revs, MaxCalls: 2, MaxOutputTokens: 256}})
	var result struct {
		Total    int  `json:"total"`
		Complete bool `json:"complete"`
		Steps    []struct {
			Name   string `json:"name"`
			Passed bool   `json:"passed"`
		} `json:"steps"`
	}
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/golden-workflows/run", f.adminToken, body, http.StatusOK), &result) != nil || result.Total != 2 || !result.Complete || len(result.Steps) != 2 || result.Steps[1].Name != "둘째 단계" || result.Steps[1].Passed {
		t.Fatal("execution did not retain the reviewed definition snapshot")
	}
	f.request(t, http.MethodPost, "/admin/golden-workflows/run", f.adminToken, body, http.StatusConflict)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) != 2 {
		t.Fatal("changed workflow executed unexpectedly")
	}
	for _, b := range f.bodies {
		if b["max_tokens"] != float64(256) || b["n"] != float64(1) {
			t.Fatal("plain-text workflow request was not bounded")
		}
	}
}

func TestGoldenReviewedCancellationStopsRemainingCallsAndMarksIncomplete(t *testing.T) {
	f := newGoldenReviewedFixture(t)
	revs := f.revisions(t, true)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	f.onCall = func(upstream context.Context) {
		cancel()
		<-upstream.Done()
	}
	body := goldenRunBody(t, map[string]any{"id": "gwf_public", "models": []string{"public-model-a", "public-model-b"}, "min_pass_rate": 0, "review": goldenRunReview{Definitions: revs, MaxCalls: 4, MaxOutputTokens: 128}})
	r := httptest.NewRequest(http.MethodPost, "/admin/golden-workflows/run?fail_on_regression=1", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+f.adminToken)
	w := httptest.NewRecorder()
	f.server.Routes().ServeHTTP(w, r)
	var result struct {
		Planned  int  `json:"planned_total"`
		Total    int  `json:"total"`
		Complete bool `json:"complete"`
	}
	if w.Code != http.StatusUnprocessableEntity || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Complete || result.Planned != 4 || result.Total != 1 {
		t.Fatal("partial execution must not be reported complete")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) != 1 {
		t.Fatal("cancellation dispatched remaining model calls")
	}
}

func TestGoldenReviewedOpenAPIContract(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	for path, schema := range map[string]string{"/admin/golden-prompts/run": "GoldenPromptRunResponse", "/admin/golden-workflows/run": "GoldenWorkflowRunResponse", "/admin/golden-prompts/run-reviewed": "GoldenPromptRunResponse", "/admin/golden-workflows/run-reviewed": "GoldenWorkflowRunResponse"} {
		for _, status := range []string{"200", "422"} {
			assertJSONOperationSchema(t, paths, path, "post", status, schema)
		}
	}
	schemas := goldenRunOpenAPISchemas()
	review := schemas["GoldenRunReview"].(map[string]any)["properties"].(map[string]any)
	if review["max_calls"].(map[string]any)["maximum"] != 64 || review["max_output_tokens"].(map[string]any)["maximum"] != 4096 {
		t.Fatal("review limit contract differs")
	}
	for _, name := range []string{"GoldenPromptRunBody", "GoldenWorkflowRunBody"} {
		fields := schemas[name].(map[string]any)["properties"].(map[string]any)
		if fields["review"].(map[string]any)["nullable"] != true || fields["min_pass_rate"].(map[string]any)["nullable"] != true {
			t.Fatal("legacy null inputs must retain their meaning")
		}
	}
}

func TestGoldenReviewedRoutesRequireReviewBeforeCallingSharedRunner(t *testing.T) {
	for _, workflow := range []bool{false, true} {
		t.Run(map[bool]string{false: "prompts", true: "workflow"}[workflow], func(t *testing.T) {
			f := newGoldenReviewedFixture(t)
			path := "/admin/golden-prompts/run-reviewed"
			if workflow {
				path = "/admin/golden-workflows/run-reviewed"
			}
			revs := f.revisions(t, workflow)
			fields := map[string]any{"models": []string{"public-model"}, "id": "gwf_public", "prompt_ids": []string{"golden_public_a", "golden_public_b"}}
			for _, body := range []string{`{`, goldenRunBody(t, fields), goldenRunBody(t, map[string]any{"models": []string{"public-model"}, "review": nil})} {
				f.request(t, http.MethodPost, path, f.adminToken, body, http.StatusBadRequest)
			}
			fields["review"] = goldenRunReview{Definitions: revs, MaxCalls: 2, MaxOutputTokens: 128}
			if !workflow {
				delete(fields, "prompt_ids")
				f.request(t, http.MethodPost, path, f.adminToken, goldenRunBody(t, fields), http.StatusBadRequest)
				fields["prompt_ids"] = []string{"golden_public_a", "golden_public_b"}
			}
			body := goldenRunBody(t, fields)
			f.request(t, http.MethodPost, path, f.reader, body, http.StatusUnauthorized)
			f.request(t, http.MethodGet, path, f.adminToken, "", http.StatusMethodNotAllowed)
			f.mu.Lock()
			before := len(f.bodies)
			f.mu.Unlock()
			if before != 0 {
				t.Fatal("rejected reviewed path called upstream")
			}
			f.request(t, http.MethodPost, path, f.adminToken, body, http.StatusOK)
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.bodies) != 2 {
				t.Fatal("reviewed path must call existing runner exactly twice")
			}
		})
	}
}

func TestGoldenReviewedPromptCancellationReportsUnstoredResult(t *testing.T) {
	f := newGoldenReviewedFixture(t)
	revs := f.revisions(t, false)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	// Wait for transport cancellation before the fixture writes a success body.
	// Otherwise a fully read response can legitimately win the cancellation race
	// and produce no execution error, despite stopping further calls/persistence.
	f.onCall = func(upstream context.Context) {
		cancel()
		<-upstream.Done()
	}
	body := goldenRunBody(t, map[string]any{"models": []string{"public-model"}, "review": goldenRunReview{Definitions: revs, MaxCalls: 2, MaxOutputTokens: 128}})
	r := httptest.NewRequest(http.MethodPost, "/admin/golden-prompts/run", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+f.adminToken)
	w := httptest.NewRecorder()
	f.server.Routes().ServeHTTP(w, r)
	var result struct {
		Total    int               `json:"total"`
		Complete bool              `json:"complete"`
		Saved    bool              `json:"results_saved"`
		Errors   map[string]string `json:"execution_errors"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Total != 1 || result.Complete || result.Saved || len(result.Errors) != 1 {
		t.Fatal("cancelled persistence and execution must be explicit")
	}
}
