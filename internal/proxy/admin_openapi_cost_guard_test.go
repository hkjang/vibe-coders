package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCostGuardOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	for _, method := range []string{"get", "post"} {
		assertJSONOperationSchema(t, paths, "/admin/cost", method, "200", "CostGuardConfigResponse")
		for _, status := range []string{"401", "503"} {
			assertJSONOperationSchema(t, paths, "/admin/cost", method, status, "AppError")
		}
	}
	assertJSONRequestSchema(t, paths, "/admin/cost", "post", "CostGuardConfigRequest")
	for _, status := range []string{"400", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/cost", "post", status, "AppError")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	response := schemas["CostGuardConfigResponse"].(map[string]any)
	if !reflect.DeepEqual(response["required"], []any{"enabled", "threshold_krw"}) {
		t.Fatal("confirmed response must require both fields")
	}
	request := schemas["CostGuardConfigRequest"].(map[string]any)
	if _, required := request["required"]; required || request["nullable"] != true {
		t.Fatal("request must preserve optional fields and the null-body no-op")
	}
	for name, schema := range map[string]map[string]any{"response": response, "request": request} {
		properties := schema["properties"].(map[string]any)
		if len(properties) != 2 || properties["enabled"].(map[string]any)["type"] != "boolean" {
			t.Fatalf("%s fields changed", name)
		}
		threshold := properties["threshold_krw"].(map[string]any)
		if threshold["type"] != "number" || threshold["minimum"] != float64(0) {
			t.Fatalf("%s threshold must permit nonnegative decimals", name)
		}
		for _, field := range []string{"enabled", "threshold_krw"} {
			nullable := properties[field].(map[string]any)["nullable"] == true
			if nullable != (name == "request") {
				t.Fatalf("%s.%s nullability changed", name, field)
			}
		}
	}
	operations := paths["/admin/cost"].(map[string]any)
	for method, fragments := range map[string][]string{
		"get":  {"uncached", "Missing flags", "malformed", "not confirmation"},
		"post": {"committed transaction", "null", "false and zero", "Malformed retained", "No optimistic concurrency", "other pods"},
	} {
		description := operations[method].(map[string]any)["description"].(string)
		for _, fragment := range fragments {
			if !strings.Contains(description, fragment) {
				t.Errorf("%s lost compatibility boundary %q", method, fragment)
			}
		}
	}
}
