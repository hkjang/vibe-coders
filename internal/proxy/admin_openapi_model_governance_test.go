package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestModelGovernanceOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	for _, operation := range []struct{ path, method, status, response, request string }{
		{"/admin/models/contracts", "get", "200", "ModelContractListResponse", ""},
		{"/admin/models/contracts", "post", "200", "ModelContractSavedResponse", "ModelContractWriteRequest"},
		{"/admin/models/contracts", "delete", "200", "ModelContractDeletedResponse", ""},
		{"/admin/models/contracts/run", "post", "200", "ModelContractRunResponse", "ModelContractRunRequest"},
		{"/admin/model-deprecations", "get", "200", "ModelDeprecationListResponse", ""},
		{"/admin/model-deprecations", "post", "201", "ModelDeprecationSavedResponse", "ModelDeprecationWriteRequest"},
		{"/admin/model-deprecations/{id}", "delete", "200", "ModelDeprecationDeletedResponse", ""},
	} {
		assertJSONOperationSchema(t, paths, operation.path, operation.method, operation.status, operation.response)
		if operation.request != "" {
			assertJSONRequestSchema(t, paths, operation.path, operation.method, operation.request)
		}
		assertJSONOperationSchema(t, paths, operation.path, operation.method, "401", "AppError")
		assertJSONOperationSchema(t, paths, operation.path, operation.method, "500", "AppError")
	}
	operation := func(path, method string) map[string]any { return paths[path].(map[string]any)[method].(map[string]any) }
	post := operation("/admin/model-deprecations", "post")
	if _, exists := post["responses"].(map[string]any)["200"]; exists {
		t.Fatal("deprecation upsert always returns 201, not generic 200")
	}
	for _, fragment := range []string{"ToLower(TrimSpace(model_glob))", "not a rename", "custom/imported", "become empty", "UTC", "201", "cache", "No CAS"} {
		if !strings.Contains(post["description"].(string), fragment) {
			t.Errorf("deprecation contract lost %q", fragment)
		}
	}
	for _, fragment := range []string{"original id", "null thresholds become 0", "enabled becomes true", "created_by", "no revision/CAS", "best-effort"} {
		if !strings.Contains(operation("/admin/models/contracts", "post")["description"].(string), fragment) {
			t.Errorf("contract upsert lost %q", fragment)
		}
	}
	for _, fragment := range []string{"Read-only computation", "not an upstream", "admin write scope", "no_data", "replaceable=false"} {
		if !strings.Contains(operation("/admin/models/contracts/run", "post")["description"].(string), fragment) {
			t.Errorf("run semantics lost %q", fragment)
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, list := range []struct{ schema, field string }{{"ModelContractListResponse", "contracts"}, {"ModelDeprecationListResponse", "deprecations"}} {
		schema := schemas[list.schema].(map[string]any)
		if !reflect.DeepEqual(schema["required"], []any{list.field}) {
			t.Fatal("confirmed list must be required")
		}
		field := schema["properties"].(map[string]any)[list.field].(map[string]any)
		if field["type"] != "array" || field["nullable"] == true {
			t.Fatal("missing/null must not mean empty")
		}
	}
	contract := schemas["ModelContractWriteRequest"].(map[string]any)
	if !reflect.DeepEqual(contract["required"], []any{"name"}) {
		t.Fatal("only name is required for legacy upsert")
	}
	fields := contract["properties"].(map[string]any)
	for _, field := range []string{"id", "task_type", "min_quality_score", "min_golden_pass_rate", "min_success_rate", "max_latency_ms", "max_avg_cost_krw", "enabled"} {
		if fields[field].(map[string]any)["nullable"] != true {
			t.Errorf("legacy field %s accepts null", field)
		}
	}
	if fields["max_latency_ms"].(map[string]any)["type"] != "integer" {
		t.Fatal("latency body is int64, not fractional")
	}
	if fields["enabled"].(map[string]any)["default"] != true {
		t.Fatal("omitted enabled must remain true")
	}
	deprecation := schemas["ModelDeprecationWriteRequest"].(map[string]any)
	if _, exists := deprecation["properties"].(map[string]any)["id"]; exists {
		t.Fatal("deprecation POST does not target imported IDs")
	}
	if len(schemas["ModelContractRecord"].(map[string]any)["required"].([]any)) != 12 {
		t.Fatal("contract row must retain all stored fields")
	}
}
