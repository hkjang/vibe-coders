package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"vibe-coders/internal/store"
)

func TestGoldenDefinitionPromptWriteContract(t *testing.T) {
	f := newModelGovernanceContractFixture(t) // Fails if any upstream model is called.
	const id = "golden_ui_public"
	var response struct {
		Prompt  store.GoldenPrompt         `json:"golden_prompt"`
		Results []store.GoldenPromptResult `json:"results"`
	}
	create := `{"id":"golden_ui_public","name":" 기준 ","prompt":" 질문 ","expected":" 기대 ","tags":["comma,tag"," spaced "]}`
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/golden-prompts", f.adminToken, create, http.StatusCreated), &response) != nil {
		t.Fatal("invalid definition acknowledgment")
	}
	if response.Prompt.ID != id || response.Prompt.Name != "기준" || response.Prompt.Prompt != "질문" || response.Prompt.Expected != " 기대 " || response.Results == nil || len(response.Results) != 0 {
		t.Fatal("definition-only save must normalize only name/prompt and never execute")
	}
	before, err := f.db.ListGoldenPrompts(t.Context())
	if err != nil || len(before) != 1 || before[0].ID != id || before[0].CreatedAt.IsZero() || before[0].UpdatedAt.IsZero() {
		t.Fatal("definition must be persisted with timestamps")
	}
	if !response.Prompt.CreatedAt.IsZero() || !response.Prompt.UpdatedAt.IsZero() {
		t.Fatal("existing input acknowledgment is not a persisted timestamp snapshot")
	}
	update := `{"id":"golden_ui_public","name":" 수정 ","prompt":" 새 질문 ","expected":"","tags":[]}`
	f.request(t, http.MethodPost, "/admin/golden-prompts", f.otherWriter, update, http.StatusCreated)
	after, err := f.db.ListGoldenPrompts(t.Context())
	if err != nil || len(after) != 1 || after[0].Name != "수정" || after[0].Prompt != "새 질문" || after[0].Expected != "" || len(after[0].Tags) != 0 || after[0].CreatedAt != before[0].CreatedAt {
		t.Fatal("same-ID update must preserve creation and apply empty expected/tags")
	}
	for _, body := range []string{`{`, `{"name":"","prompt":"q"}`, `{"name":"n","prompt":" "}`} {
		f.request(t, http.MethodPost, "/admin/golden-prompts", f.adminToken, body, http.StatusBadRequest)
	}
	f.request(t, http.MethodPost, "/admin/golden-prompts", f.reader, update, http.StatusUnauthorized)
	f.request(t, http.MethodPost, "/admin/golden-prompts", f.scopeless, update, http.StatusUnauthorized)
	final, err := f.db.ListGoldenPrompts(t.Context())
	if err != nil || !reflect.DeepEqual(final, after) || len(f.audits(t)) != 2 {
		t.Fatal("invalid/unauthorized requests must not change definitions or accepted-write audits")
	}
	for _, event := range f.audits(t) {
		if event.Action != "governance.golden.upsert" {
			t.Fatal("existing audit action changed")
		}
	}
}

func TestGoldenDefinitionWorkflowWriteContract(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	create := `{"id":"gwf_ui_public","name":" 세트 ","description":" 설명 ","tags":["a,b"],"steps":[{"name":" 첫 검사 ","prompt":" 첫 질문 ","expected":" 기대 ","baseline_score":82.5,"task_type":"public","selected_model":"public-model","contract_id":"public-contract","rubric_id":"public-rubric","source_run_id":"public-run"},{"name":"빈 단계","prompt":" "}]}`
	var acknowledgment store.GoldenWorkflow
	if json.Unmarshal(f.request(t, http.MethodPost, "/admin/golden-workflows", f.adminToken, create, http.StatusOK), &acknowledgment) != nil {
		t.Fatal("invalid workflow acknowledgment")
	}
	before, err := f.db.GetGoldenWorkflow(t.Context(), "gwf_ui_public")
	if err != nil || before.Name != "세트" || before.Description != " 설명 " || len(before.Steps) != 1 || before.Steps[0].Name != "첫 검사" || before.Steps[0].Prompt != "첫 질문" || before.Steps[0].Expected != " 기대 " || !reflect.DeepEqual(before.Steps, acknowledgment.Steps) || before.Steps[0].BaselineScore != 82.5 {
		t.Fatal("workflow must preserve provenance and the existing trimming/empty-step behavior")
	}
	steps := append([]store.GoldenWorkflowStep{{Name: "둘째", Prompt: "다른 질문", Expected: ""}}, before.Steps...)
	body, err := json.Marshal(map[string]any{"id": before.ID, "name": "수정 세트", "description": "", "tags": []string{}, "steps": steps})
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, http.MethodPost, "/admin/golden-workflows", f.otherWriter, string(body), http.StatusOK)
	after, err := f.db.GetGoldenWorkflow(t.Context(), before.ID)
	if err != nil || after.Name != "수정 세트" || after.Description != "" || !reflect.DeepEqual(after.Steps, steps) || after.CreatedAt != before.CreatedAt {
		t.Fatal("workflow reorder/update must retain provenance and creation metadata")
	}
	for _, invalid := range []string{`{`, `{"name":"n","steps":[]}`, `{"name":"n","steps":[{"prompt":" "}]}`, `{"name":"","steps":[{"prompt":"q"}]}`} {
		f.request(t, http.MethodPost, "/admin/golden-workflows", f.adminToken, invalid, http.StatusBadRequest)
	}
	f.request(t, http.MethodPost, "/admin/golden-workflows", f.reader, string(body), http.StatusUnauthorized)
	final, err := f.db.GetGoldenWorkflow(t.Context(), before.ID)
	if err != nil || !reflect.DeepEqual(after, final) || len(f.audits(t)) != 2 {
		t.Fatal("rejected saves must not mutate the workflow or accepted audits")
	}
	for _, event := range f.audits(t) {
		if event.Action != "governance.golden.workflow.upsert" || event.BeforeValue != before.ID {
			t.Fatal("workflow audit target changed")
		}
	}
}

func TestGoldenDefinitionWriteOpenAPIContract(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/golden-prompts", "post", "201", "GoldenPromptWriteResponse")
	assertJSONOperationSchema(t, paths, "/admin/golden-workflows", "post", "200", "GoldenWorkflow")
}

func TestGoldenDefinitionWorkflowMinimalWrite(t *testing.T) {
	f := newModelGovernanceContractFixture(t)
	body := `{"id":"gwf_ui_minimal","name":"최소 검사","steps":[{}, {"prompt":" 질문 "}]}`
	f.request(t, http.MethodPost, "/admin/golden-workflows", f.adminToken, body, http.StatusOK)
	stored, err := f.db.GetGoldenWorkflow(t.Context(), "gwf_ui_minimal")
	if err != nil || len(stored.Steps) != 1 || stored.Steps[0].Prompt != "질문" || stored.Steps[0].Name != "" || stored.Steps[0].Expected != "" {
		t.Fatal("existing minimal input must omit optional name/expected and discard empty steps")
	}
	schemas := goldenReadOpenAPISchemas()
	input := schemas["GoldenWorkflowStepInput"].(map[string]any)
	if _, required := input["required"]; required {
		t.Fatal("input step fields are optional; response fields remain required")
	}
}
