package proxy

import (
	"reflect"
	"strings"
	"testing"
)

func TestRoutingCreateOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	op := paths["/admin/routing-rules"].(map[string]any)["post"].(map[string]any)
	responses := op["responses"].(map[string]any)
	if responses["201"] == nil {
		t.Fatal("POST lacks its actual 201 typed create acknowledgment")
	}
	assertJSONOperationSchema(t, paths, "/admin/routing-rules", "post", "201", "RoutingRuleWriteResponse")
	assertJSONRequestSchema(t, paths, "/admin/routing-rules", "post", "RoutingRuleCreateRequest")
	for _, status := range []string{"400", "401", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/routing-rules", "post", status, "AppError")
	}
	if responses["200"] != nil || responses["404"] != nil || responses["409"] != nil {
		t.Fatal("create must not invent 200/404/409 outcomes")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request, ok := schemas["RoutingRuleCreateRequest"].(map[string]any)
	if !ok || request["type"] != "object" || request["required"] != nil || request["additionalProperties"] != true {
		t.Fatal("create input must preserve optional/alias/unknown-field decoder compatibility")
	}
	properties := request["properties"].(map[string]any)
	if len(properties) != 8 || properties["id"] != nil || properties["created_at"] != nil {
		t.Fatal("create has eight known inputs, never client-assigned identity/time")
	}
	for field, raw := range properties {
		if raw.(map[string]any)["nullable"] != true {
			t.Fatalf("create null compatibility omitted for %s", field)
		}
	}
	priority := properties["priority"].(map[string]any)
	if priority["type"] != "integer" || priority["minimum"] != nil {
		t.Fatal("create priority is an integer; nonpositive values default rather than fail")
	}
	response := schemas["RoutingRuleWriteResponse"].(map[string]any)
	if !reflect.DeepEqual(response["required"], []string{"rule"}) || response["properties"].(map[string]any)["rule"].(map[string]any)["$ref"] != "#/components/schemas/RoutingRuleView" {
		t.Fatal("create must reuse the actual ten-field write acknowledgment")
	}
	view := schemas["RoutingRuleView"].(map[string]any)
	created := view["properties"].(map[string]any)["created_at"].(map[string]any)
	if !strings.Contains(created["description"].(string), "POST") || !strings.Contains(created["description"].(string), "0001-01-01T00:00:00Z") {
		t.Fatal("shared timestamp schema must disclose existing POST zero-time acknowledgment")
	}
	description := op["description"].(string)
	for _, fragment := range []string{"routing:write", "routing:read", "201", "0001-01-01T00:00:00Z", "no revision/CAS", "idempotency", "best-effort", "five-second", "post-change", "Response loss", "case-insensitive"} {
		if !strings.Contains(description, fragment) {
			t.Errorf("missing existing create contract boundary %q", fragment)
		}
	}
}
