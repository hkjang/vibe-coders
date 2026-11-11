package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestGoldenReadContractScopeLimitsAndStoredParity(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	for _, id := range []string{"public-golden-a", "public-golden-b"} {
		if err := f.db.UpsertGoldenPrompt(t.Context(), store.GoldenPrompt{ID: id, Name: id, Prompt: "public question", Expected: "public answer", Tags: []string{"public"}}); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 205 {
		id := "public-golden-a"
		if i == 204 {
			id = "public-golden-b"
		}
		if err := f.db.InsertGoldenPromptResult(t.Context(), store.GoldenPromptResult{
			ID: fmt.Sprintf("public-result-%03d", i), PromptID: id, Model: "public-model", Score: 0.6,
			Passed: true, CostKRW: 1.25, LatencyMS: 1200, Response: "public answer",
			CreatedAt: time.Date(2030, 1, 1, 0, 0, i, 0, time.UTC),
		}); err != nil {
			t.Fatal(err)
		}
	}
	storedPrompts, err := f.db.ListGoldenPrompts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query, prompt string
		count         int
	}{
		{"", "", 50}, {"?limit=999", "", 200}, {"?limit=invalid", "", 50},
		{"?prompt_id=public-golden-a&limit=200", "public-golden-a", 200},
		{"?prompt_id=public-golden-b&limit=200", "public-golden-b", 1},
		{"?prompt_id=missing&limit=200", "missing", 0},
	} {
		t.Run(tc.query, func(t *testing.T) {
			var got struct {
				Prompts []store.GoldenPrompt       `json:"golden_prompts"`
				Results []store.GoldenPromptResult `json:"results"`
			}
			body := f.request(t, http.MethodGet, "/admin/golden-prompts"+tc.query, f.reader, "", http.StatusOK)
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Prompts, storedPrompts) || len(got.Results) != tc.count {
				t.Fatal("result filtering must preserve the complete registry and apply the documented result bound")
			}
			expected, err := f.db.ListGoldenPromptResults(t.Context(), tc.prompt, max(tc.count, 1))
			if err != nil || !reflect.DeepEqual(got.Results, expected) {
				t.Fatal("HTTP result order/content differs from existing storage")
			}
		})
	}
	for _, path := range []string{"/admin/golden-prompts", "/admin/golden-workflows"} {
		f.request(t, http.MethodGet, path, f.scopeless, "", http.StatusUnauthorized)
		f.request(t, http.MethodGet, path, "", "", http.StatusUnauthorized)
		f.request(t, http.MethodPost, path, f.reader, `{}`, http.StatusUnauthorized)
	}
	for _, path := range []string{"/admin/golden-prompts/run", "/admin/golden-workflows/run"} {
		f.request(t, http.MethodPost, path, f.reader, `{"models":["public-model"]}`, http.StatusUnauthorized)
	}
}

func TestGoldenReadWorkflowContractPreservesOrderAndUnknownSteps(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	for _, wf := range []store.GoldenWorkflow{
		{ID: "public-workflow", Name: "공개 검증 세트", Steps: []store.GoldenWorkflowStep{
			{Name: "첫 검사", Prompt: "first", Expected: "one", SelectedModel: "public-model", BaselineScore: 82.5, TaskType: "public", SourceRunID: "public-run", ContractID: "public-contract", RubricID: "public-rubric"},
			{Name: "둘째 검사", Prompt: "second", Expected: "two"},
		}},
		{ID: "public-unknown", Name: "단계 미확인", Steps: nil},
	} {
		if err := f.db.UpsertGoldenWorkflow(t.Context(), wf); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := f.db.ListGoldenWorkflows(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Workflows []store.GoldenWorkflow `json:"workflows"`
	}
	if err := json.Unmarshal(f.request(t, http.MethodGet, "/admin/golden-workflows", f.reader, "", http.StatusOK), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Workflows, stored) {
		t.Fatal("read API must preserve steps, provenance and null definitions")
	}
}

func TestGoldenReadOpenAPIContracts(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/golden-prompts", "get", "200", "GoldenPromptListResponse")
	assertJSONOperationSchema(t, paths, "/admin/golden-workflows", "get", "200", "GoldenWorkflowListResponse")
	assertOpenAPIParameterSchema(t, paths, "/admin/golden-prompts", "get", "query", "limit", "integer", false)
	assertOpenAPIParameterSchema(t, paths, "/admin/golden-prompts", "get", "query", "prompt_id", "string", false)
}
