package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSkillFitnessOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	const path = "/admin/skills/fitness"
	assertJSONOperationSchema(t, paths, path, "get", "200", "SkillFitnessResponse")
	assertJSONOperationSchema(t, paths, path, "post", "201", "SkillFitnessRecordedResponse")
	assertJSONRequestSchema(t, paths, path, "post", "SkillFitnessAppendRequest")
	operations := paths[path].(map[string]any)
	get := operations["get"].(map[string]any)
	post := operations["post"].(map[string]any)
	if _, has := post["responses"].(map[string]any)["200"]; has {
		t.Fatal("append returns 201, not the generic template's 200")
	}
	parameters := get["parameters"].([]any)
	count := 0
	for _, parameter := range parameters {
		p := parameter.(map[string]any)
		if p["name"] == "skill" && p["in"] == "query" && p["required"] == true {
			count++
		}
	}
	if count != 1 {
		t.Fatal("GET must require exactly one skill query parameter")
	}
	for _, method := range []string{"get", "post"} {
		for _, status := range []string{"400", "401", "405", "500"} {
			assertJSONOperationSchema(t, paths, path, method, status, "AppError")
		}
	}
	for _, fragment := range []string{"duplicate references", "not verified", "null score is 0", "created_at empty", "best-effort", "does not execute"} {
		if !strings.Contains(post["description"].(string), fragment) {
			t.Errorf("append contract lost %q", fragment)
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["SkillFitnessAppendRequest"].(map[string]any)
	if !reflect.DeepEqual(request["required"], []any{"skill"}) || request["nullable"] == true {
		t.Fatal("append requires only a non-null skill name/body")
	}
	fields := request["properties"].(map[string]any)
	for _, name := range []string{"kind", "ref_id", "passed", "score", "note"} {
		if fields[name].(map[string]any)["nullable"] != true {
			t.Errorf("legacy optional %s must still accept null", name)
		}
	}
	if _, has := fields["kind"].(map[string]any)["enum"]; has {
		t.Fatal("unknown kinds are accepted with a default, not rejected as an enum")
	}
	for _, name := range []string{"SkillFitnessEvidence", "SkillFitnessRecordedResponse"} {
		row := schemas[name].(map[string]any)
		if len(row["required"].([]any)) != 9 {
			t.Fatal("evidence response lost a required field")
		}
		properties := row["properties"].(map[string]any)
		timestamp := properties["created_at"].(map[string]any)
		if name == "SkillFitnessEvidence" && timestamp["format"] != "date-time" {
			t.Fatal("GET must describe the persisted timestamp")
		}
		if name == "SkillFitnessRecordedResponse" {
			variants := timestamp["oneOf"].([]any)
			if len(variants) != 2 || !reflect.DeepEqual(variants[0].(map[string]any)["enum"], []any{""}) || variants[1].(map[string]any)["format"] != "date-time" {
				t.Fatal("201 must explicitly allow the legacy empty timestamp")
			}
		}
	}
}
