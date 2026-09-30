package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const multiModelContractPrompt = "Public synthetic question A"
const multiModelContractAnswer = "Public synthetic explanation.\n\n- first step\n- second step\n\n```python\ndef add(a, b):\n    return a + b\n```"

// These requests use actual Routes, persisted JWT sessions, the chat pipeline,
// a loopback-only synthetic model and the test database. No business handler is
// called directly or substituted. Golden tests pin explicit-prompt semantics;
// they do not claim to execute the React editor's A-to-B draft transition.
func TestMultiModelRunContractStoredSuccessReachesPostprocessing(t *testing.T) {
	f := newMultiModelRunContractFixture(t)
	run, _ := f.run(t)
	f.assertPostprocessing(t, run.ID)
}

func TestMultiModelRunContractLegacyOKControl(t *testing.T) {
	f := newMultiModelRunContractFixture(t)
	run, results := f.run(t)
	// A separate old/imported status control. The real HTTP-produced row above
	// remains unchanged; only this explicitly labelled copy uses legacy "ok".
	run.ID = "mmt-public-legacy-ok-control"
	for i := range results {
		results[i].Status = "ok"
		results[i].RunID = run.ID
	}
	if err := f.db.SaveMultiModelRun(t.Context(), run, results); err != nil {
		t.Fatal("legacy control seed failed")
	}
	f.assertPostprocessing(t, run.ID)
}

func TestMultiModelRunContractGoldenExplicitPromptSemantics(t *testing.T) {
	f := newMultiModelRunContractFixture(t)
	run, results := f.run(t)
	path := "/admin/chat-test/multi-run/runs/" + run.ID + "/golden"
	var missing struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	f.json(t, http.MethodPost, path, f.adminToken, map[string]any{
		"selected_model": "test-model", "workflow_name": "Public missing prompt control",
	}, http.StatusBadRequest, &missing)
	if missing.Error.Code != "missing_prompt" {
		t.Fatal("an unsaved prompt must require an explicit Golden prompt")
	}
	for _, prompt := range []string{multiModelContractPrompt, "Public explicit replacement question B"} {
		var saved struct {
			Status     string `json:"status"`
			WorkflowID string `json:"workflow_id"`
			StepCount  int    `json:"step_count"`
		}
		f.json(t, http.MethodPost, path, f.adminToken, map[string]any{
			"selected_model": "test-model", "workflow_name": "Public Golden contract", "prompt": prompt,
		}, http.StatusOK, &saved)
		workflow, err := f.db.GetGoldenWorkflow(t.Context(), saved.WorkflowID)
		if err != nil || saved.Status != "saved" || saved.StepCount != 1 || len(workflow.Steps) != 1 {
			t.Fatal("Golden must create one persisted workflow step")
		}
		step := workflow.Steps[0]
		if step.Prompt != prompt || step.SourceRunID != run.ID || step.SelectedModel != "test-model" {
			t.Fatal("Golden must preserve its explicit prompt and source-run/model association")
		}
	}
	after, afterResults, _, found, err := f.db.GetMultiModelRun(t.Context(), run.ID)
	if err != nil || !found || !reflect.DeepEqual(after, run) || !reflect.DeepEqual(afterResults, results) {
		t.Fatal("Golden must not rewrite the original run, its prompt hash or stored response")
	}
	if f.upstreamCalls.Load() != 1 {
		t.Fatal("Golden persistence must not make another model call")
	}
}

func TestMultiModelRunContractDeniedWritesNeverReachModel(t *testing.T) {
	f := newMultiModelRunContractFixture(t)
	for _, token := range []string{"", f.reader} {
		for _, path := range []string{
			"/admin/chat-test/multi-run", "/admin/chat-test/multi-run/predict",
			"/admin/chat-test/multi-run/judge", "/admin/chat-test/multi-run/runs/missing/golden",
		} {
			f.json(t, http.MethodPost, path, token, map[string]any{}, http.StatusUnauthorized, nil)
		}
	}
	// Raw history permission is distinct from mutation scope; retain both.
	f.json(t, http.MethodGet, "/admin/chat-test/multi-run/runs", f.reader, nil, http.StatusForbidden, nil)
	f.json(t, http.MethodGet, "/admin/chat-test/multi-run/runs", f.adminToken, nil, http.StatusOK, nil)
	runs, err := f.db.ListMultiModelRuns(t.Context(), 20)
	if err != nil || len(runs) != 0 || f.upstreamCalls.Load() != 0 {
		t.Fatal("denied writes must not run a model or create a comparison")
	}
}

type multiModelRunContractFixture struct {
	*apiKeyScopeContractFixture // Existing safe real HTTP transport helper only.
	reader                      string
}

func newMultiModelRunContractFixture(t *testing.T) *multiModelRunContractFixture {
	t.Helper()
	f := &multiModelRunContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.upstreamCalls.Add(1)
		var body struct {
			Model    string `json:"model"`
			Stream   bool   `json:"stream"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" ||
			json.NewDecoder(r.Body).Decode(&body) != nil || body.Model != "test-model" || body.Stream ||
			len(body.Messages) != 1 || body.Messages[0].Role != "user" || body.Messages[0].Content != multiModelContractPrompt {
			t.Error("loopback received an unexpected model request")
			http.Error(w, "synthetic request mismatch", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": multiModelContractAnswer}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 7, "completion_tokens": 13, "total_tokens": 20},
		}); err != nil {
			t.Error("synthetic model response encoding failed")
		}
	}))
	t.Cleanup(upstream.Close)
	var server *Server
	f.gateway, server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	if !server.cfg.Auth.Enabled {
		t.Fatal("multi-model contracts require real enabled authentication")
	}
	f.adminToken = issueLLMScopedTestToken(t, f.db, server, "public-multi-writer", "super_admin", "public-team",
		[]string{"admin:read", "admin:write"}, time.Now().UTC())
	f.reader = issueLLMScopedTestToken(t, f.db, server, "public-multi-reader", "readonly_admin", "public-team",
		[]string{"admin:read"}, time.Now().UTC())
	return f
}

func (f *multiModelRunContractFixture) json(t *testing.T, method, path, token string, body any, status int, output any) {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal("public contract payload encoding failed")
		}
	}
	data := f.request(t, method, path, token, string(encoded), status)
	if output != nil && json.Unmarshal(data, output) != nil {
		t.Fatal("contract response shape was not valid JSON")
	}
}

func (f *multiModelRunContractFixture) run(t *testing.T) (store.MultiModelTestRun, []store.MultiModelTestResult) {
	t.Helper()
	messages := []map[string]string{{"role": "user", "content": multiModelContractPrompt}}
	var got struct {
		Status  string           `json:"status"`
		RunID   string           `json:"run_id"`
		Results []multiRunResult `json:"results"`
	}
	f.json(t, http.MethodPost, "/admin/chat-test/multi-run", f.adminToken, map[string]any{
		"title": "Public contract run", "models": []map[string]string{{"model": "test-model"}},
		"messages": messages, "params": map[string]any{"max_tokens": 100}, "save_prompt": false,
	}, http.StatusOK, &got)
	if got.Status != "completed" || got.RunID == "" || len(got.Results) != 1 ||
		got.Results[0].Status != "success" || got.Results[0].Content != multiModelContractAnswer || f.upstreamCalls.Load() != 1 {
		t.Fatal("control: authenticated HTTP run did not return one actual loopback success")
	}
	run, results, _, found, err := f.db.GetMultiModelRun(t.Context(), got.RunID)
	encoded, _ := json.Marshal(messages)
	if err != nil || !found || run.Success != 1 || run.Failed != 0 || run.CreatedBy != "public-multi-writer" ||
		run.PromptPreview != "" || run.PromptHash != audit.HashText(string(encoded)) || len(results) != 1 ||
		results[0].Status != "success" || results[0].StatusCode != http.StatusOK || results[0].ResponsePreview != multiModelContractAnswer {
		t.Fatal("control: committed run must retain success, response preview and hash without a prompt preview")
	}
	var listed struct {
		Runs []store.MultiModelTestRun `json:"runs"`
	}
	f.json(t, http.MethodGet, "/admin/chat-test/multi-run/runs", f.adminToken, nil, http.StatusOK, &listed)
	if len(listed.Runs) != 1 || !reflect.DeepEqual(listed.Runs[0], run) {
		t.Fatal("control: authenticated history must expose the committed comparison")
	}
	return run, results
}

func (f *multiModelRunContractFixture) assertPostprocessing(t *testing.T, runID string) {
	t.Helper()
	t.Run("judge", func(t *testing.T) {
		var result struct {
			Judgements []store.MultiModelTestJudgement `json:"judgements"`
		}
		f.json(t, http.MethodPost, "/admin/chat-test/multi-run/judge", f.adminToken,
			map[string]string{"run_id": runID, "method": "rule"}, http.StatusOK, &result)
		if len(result.Judgements) != 1 {
			t.Fatal("judge did not return exactly one result")
		}
		judgement := result.Judgements[0]
		if judgement.TotalScore <= 0 || strings.Contains(judgement.ReasonSummary, "응답 없음/실패") {
			t.Errorf("stored successful answer was excluded from rule scoring: positive_score=%t excluded=%t",
				judgement.TotalScore > 0, strings.Contains(judgement.ReasonSummary, "응답 없음/실패"))
		}
		stored, err := f.db.ListMultiModelJudgements(t.Context(), runID)
		if err != nil || len(stored) != 1 || stored[0].TotalScore != judgement.TotalScore || stored[0].CreatedBy != "public-multi-writer" {
			t.Fatal("rule judge response and persisted judgment disagree")
		}
	})
	t.Run("diff", func(t *testing.T) {
		var result struct {
			Answered int `json:"answered_models"`
			Models   []struct {
				Blocks []json.RawMessage `json:"blocks"`
			} `json:"models"`
		}
		f.json(t, http.MethodGet, "/admin/chat-test/multi-run/runs/"+runID+"/diff", f.adminToken, nil, http.StatusOK, &result)
		if result.Answered != 1 || len(result.Models) != 1 || len(result.Models[0].Blocks) == 0 {
			t.Errorf("stored successful answer was excluded from diff: answered_models=%d", result.Answered)
		}
	})
	t.Run("code", func(t *testing.T) {
		var result struct {
			WithCode    int `json:"models_with_code"`
			Leaderboard []struct {
				Available bool `json:"available"`
				Blocks    int  `json:"block_count"`
			} `json:"leaderboard"`
		}
		f.json(t, http.MethodGet, "/admin/chat-test/multi-run/runs/"+runID+"/code-verify", f.adminToken, nil, http.StatusOK, &result)
		if result.WithCode != 1 || len(result.Leaderboard) != 1 || !result.Leaderboard[0].Available || result.Leaderboard[0].Blocks != 1 {
			t.Errorf("stored successful code answer was excluded from code verification: models_with_code=%d", result.WithCode)
		}
	})
	if f.upstreamCalls.Load() != 1 {
		t.Fatal("rule judge, diff and code verification must not invoke another model")
	}
}
