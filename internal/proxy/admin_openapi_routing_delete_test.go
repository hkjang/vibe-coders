package proxy

import (
	"reflect"
	"strings"
	"testing"
)

func TestRoutingDeleteOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/routing-rules/{id}", "delete", "200", "RoutingRuleDeleteResponse")
	for _, status := range []string{"400", "401", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/routing-rules/{id}", "delete", status, "AppError")
	}
	op := paths["/admin/routing-rules/{id}"].(map[string]any)["delete"].(map[string]any)
	if op["requestBody"] != nil || op["responses"].(map[string]any)["404"] != nil {
		t.Fatal("DELETE ignores a body and does not report absent rows as 404")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	response, ok := schemas["RoutingRuleDeleteResponse"].(map[string]any)
	if !ok {
		t.Fatal("missing typed DELETE acknowledgment schema")
	}
	if response["type"] != "object" || response["additionalProperties"] != false ||
		!reflect.DeepEqual(response["required"], []string{"id", "status"}) {
		t.Fatal("DELETE acknowledgment must require exactly its two known fields")
	}
	fields := response["properties"].(map[string]any)
	if len(fields) != 2 || fields["id"].(map[string]any)["type"] != "string" ||
		fields["status"].(map[string]any)["type"] != "string" ||
		!reflect.DeepEqual(fields["status"].(map[string]any)["enum"], []string{"deleted"}) {
		t.Fatal("DELETE acknowledgment shape or literal status drifted")
	}
	description := op["description"].(string)
	for _, fragment := range []string{"routing:write", "routing:read", "already absent", "affected-row", "no revision/CAS", "best-effort", "five-second", "post-change", "Response loss", "recreated"} {
		if !strings.Contains(description, fragment) {
			t.Errorf("missing existing DELETE contract boundary %q", fragment)
		}
	}
}
