package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestValidateOutputContract(t *testing.T) {
	// JSON schema-lite: required keys + types.
	c := store.PromptContract{Type: "json_schema", SchemaJSON: `{"required":["name","age"],"properties":{"name":"string","age":"number"}}`}
	if ok, errs := validateOutputContract(c, `{"name":"Sam","age":30}`); !ok {
		t.Errorf("valid object should pass, errs=%v", errs)
	}
	if ok, _ := validateOutputContract(c, `{"name":"Sam"}`); ok {
		t.Error("missing required field should fail")
	}
	if ok, _ := validateOutputContract(c, `{"name":"Sam","age":"thirty"}`); ok {
		t.Error("wrong type should fail")
	}
	// Fenced JSON is unwrapped.
	if ok, _ := validateOutputContract(c, "```json\n{\"name\":\"Sam\",\"age\":1}\n```"); !ok {
		t.Error("fenced JSON should be parsed")
	}

	// Markdown table.
	mt := store.PromptContract{Type: "markdown_table"}
	if ok, _ := validateOutputContract(mt, "| a | b |\n| --- | --- |\n| 1 | 2 |"); !ok {
		t.Error("markdown table should pass")
	}
	if ok, _ := validateOutputContract(mt, "no table here"); ok {
		t.Error("non-table should fail")
	}

	// SQL read-only.
	sq := store.PromptContract{Type: "sql"}
	if ok, _ := validateOutputContract(sq, "SELECT id FROM users"); !ok {
		t.Error("SELECT should pass")
	}
	if ok, _ := validateOutputContract(sq, "DELETE FROM users"); ok {
		t.Error("DELETE should fail")
	}
	if ok, _ := validateOutputContract(sq, "SELECT 1; DROP TABLE x"); ok {
		t.Error("embedded DDL should fail")
	}

	// Regex.
	rx := store.PromptContract{Type: "regex", SchemaJSON: `^\d{4}-\d{2}-\d{2}$`}
	if ok, _ := validateOutputContract(rx, "2026-06-20"); !ok {
		t.Error("date should match regex")
	}
	if ok, _ := validateOutputContract(rx, "not a date"); ok {
		t.Error("non-date should fail regex")
	}
}

func TestPromptLabStoreLifecycle(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()

	exp := store.PromptExperiment{ID: "e1", Title: "Exp", Owner: "me"}
	if err := db.CreatePromptExperiment(ctx, exp); err != nil {
		t.Fatal(err)
	}
	tc := store.PromptTestCase{ID: "tc1", ExperimentID: "e1", Name: "case", MessagesJSON: "[]"}
	if err := db.CreatePromptTestCase(ctx, tc); err != nil {
		t.Fatal(err)
	}
	cases, err := db.ListPromptTestCases(ctx, "e1")
	if err != nil || len(cases) != 1 {
		t.Fatalf("list cases = %d err=%v", len(cases), err)
	}
	if err := db.InsertPromptTestCaseRun(ctx, store.PromptTestCaseRun{ID: "r1", TestCaseID: "tc1", BestModel: "m", AvgScore: 80, ModelCount: 2}); err != nil {
		t.Fatal(err)
	}
	hist, err := db.ListPromptTestCaseRuns(ctx, "tc1", 10)
	if err != nil || len(hist) != 1 || hist[0].BestModel != "m" {
		t.Fatalf("history mismatch len=%d err=%v", len(hist), err)
	}
	// Deleting the experiment cascades to cases + runs.
	if err := db.DeletePromptExperiment(ctx, "e1"); err != nil {
		t.Fatal(err)
	}
	if cases, _ := db.ListPromptTestCases(ctx, "e1"); len(cases) != 0 {
		t.Error("cases should be deleted with experiment")
	}
	if hist, _ := db.ListPromptTestCaseRuns(ctx, "tc1", 10); len(hist) != 0 {
		t.Error("runs should be deleted with experiment")
	}
}
