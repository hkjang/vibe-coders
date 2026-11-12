package proxy

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestWorkflowPageOpenAPIContract(t *testing.T) {
	op, responses := map[string]any{}, map[string]any{}
	enrichWorkflowPageOpenAPI(op, responses)
	parameters := op["parameters"].([]any)
	names := []string{}
	for _, parameter := range parameters {
		names = append(names, parameter.(map[string]any)["name"].(string))
	}
	if !reflect.DeepEqual(names, []string{"view", "id", "q", "status", "sort", "limit", "offset"}) {
		t.Fatal("workflow view parameters missing")
	}
	for _, status := range []string{"200", "400", "401", "500"} {
		if responses[status] == nil {
			t.Fatal("workflow view response missing")
		}
	}
	schemas := workflowPageOpenAPISchemas()
	metadata := schemas["WorkflowMetadata"].(map[string]any)
	properties := metadata["properties"].(map[string]any)
	if properties["steps"] != nil || properties["step_count"] == nil || metadata["additionalProperties"] != false {
		t.Fatal("metadata contract permits full step definitions")
	}
	detail := schemas["WorkflowDetail"].(map[string]any)["properties"].(map[string]any)["workflow"].(map[string]any)
	if detail["nullable"] != true {
		t.Fatal("missing exact detail must be nullable")
	}
	definition := schemas["WorkflowDefinition"].(map[string]any)["properties"].(map[string]any)
	if definition["steps"] == nil || definition["step_count"] != nil {
		t.Fatal("detail contract lost full definition")
	}
	// Serialize to catch unsupported schema values before publishing the live spec.
	if _, err := json.Marshal(map[string]any{"operation": op, "responses": responses, "schemas": schemas}); err != nil {
		t.Fatal(err)
	}
}
