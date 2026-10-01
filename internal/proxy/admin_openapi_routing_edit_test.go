package proxy

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestRoutingEditOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/routing-rules", "get", "200", "RoutingRuleListResponse")
	assertJSONOperationSchema(t, paths, "/admin/routing-rules/{id}", "patch", "200", "RoutingRuleWriteResponse")
	assertJSONRequestSchema(t, paths, "/admin/routing-rules/{id}", "patch", "RoutingRulePatchRequest")
	for _, status := range []string{"400", "401", "404", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/routing-rules/{id}", "patch", status, "AppError")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	view := schemas["RoutingRuleView"].(map[string]any)
	wantFields := []string{"id", "enabled", "priority", "match_pattern", "min_complexity", "max_complexity", "target_model", "target_provider", "note", "created_at"}
	if !reflect.DeepEqual(view["required"], wantFields) {
		t.Fatal("review must require all ten original fields without coercion/defaults")
	}
	// Bind the schema to the actual Go DTO's emitted zero values as well.
	encoded, err := json.Marshal(store.RoutingRule{})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire) != len(wantFields) {
		t.Fatal("stored rule JSON and documented field count disagree")
	}
	for _, field := range wantFields {
		if _, ok := wire[field]; !ok || wire[field] == nil {
			t.Fatalf("missing/non-null wire field %s", field)
		}
	}
	request := schemas["RoutingRulePatchRequest"].(map[string]any)
	if request["required"] != nil || request["nullable"] != true || request["additionalProperties"] != true {
		t.Fatal("optional/null/unknown-field compatibility must remain documented")
	}
	properties := request["properties"].(map[string]any)
	if len(properties) != 8 || properties["id"] != nil || properties["created_at"] != nil {
		t.Fatal("PATCH permits only eight known editable fields, never identity/creation time")
	}
	for field, raw := range properties {
		if raw.(map[string]any)["nullable"] != true {
			t.Fatalf("omitted and null must retain %s", field)
		}
	}
	list := schemas["RoutingRuleListResponse"].(map[string]any)
	listFields := list["properties"].(map[string]any)["rules"].(map[string]any)
	if !slices.Contains(list["required"].([]string), "rules") || listFields["type"] != "array" || listFields["nullable"] == true {
		t.Fatal("actual empty array must not become absent or null")
	}
	patch := paths["/admin/routing-rules/{id}"].(map[string]any)["patch"].(map[string]any)
	description := patch["description"].(string)
	for _, fragment := range []string{"routing:write", "UPDATE RETURNING", "never inserted", "no revision/CAS", "last-writer-wins", "best-effort", "five-second", "null body", "Response loss"} {
		if !strings.Contains(description, fragment) {
			t.Errorf("missing actual write boundary %q", fragment)
		}
	}
}
