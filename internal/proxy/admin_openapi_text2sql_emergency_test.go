package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestText2SQLEmergencyOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	const path = "/admin/text2sql/kill-switch"
	assertJSONOperationSchema(t, paths, path, "get", "200", "Text2SQLEmergencyState")
	assertJSONOperationSchema(t, paths, path, "post", "200", "Text2SQLEmergencyState")
	assertJSONRequestSchema(t, paths, path, "post", "Text2SQLEmergencyChangeRequest")
	for _, code := range []string{"400", "409", "500", "503"} {
		assertJSONOperationSchema(t, paths, path, "post", code, "AppError")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["Text2SQLEmergencyChangeRequest"].(map[string]any)
	if _, required := request["required"]; required || request["nullable"] != true {
		t.Fatal("legacy null/omitted compatibility changed")
	}
	state := schemas["Text2SQLEmergencyState"].(map[string]any)
	if !reflect.DeepEqual(state["required"], []any{"disabled", "config_enabled", "scope", "instance_ref", "review_token", "observed_at"}) {
		t.Fatal("review state contract is incomplete")
	}
	description := paths[path].(map[string]any)["post"].(map[string]any)["description"].(string)
	for _, boundary := range []string{"Not cluster-wide or durable", "A-B-A", "Configuration itself is not", "audit record", "process crash", "unguarded legacy"} {
		if !strings.Contains(description, boundary) {
			t.Fatalf("missing boundary: %s", boundary)
		}
	}
}
