package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRedTeamEmergencyOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	const path = "/admin/redteam/kill-switch"
	assertJSONOperationSchema(t, paths, path, "get", "200", "RedTeamEmergencyState")
	assertJSONOperationSchema(t, paths, path, "post", "200", "RedTeamEmergencyState")
	assertJSONRequestSchema(t, paths, path, "post", "RedTeamEmergencyChangeRequest")
	for _, code := range []string{"400", "409", "500", "503"} {
		assertJSONOperationSchema(t, paths, path, "post", code, "AppError")
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["RedTeamEmergencyChangeRequest"].(map[string]any)
	if _, required := request["required"]; required || request["nullable"] != true {
		t.Fatal("legacy null/omitted compatibility changed")
	}
	state := schemas["RedTeamEmergencyState"].(map[string]any)
	if !reflect.DeepEqual(state["required"], []any{"enabled", "scope", "instance_ref", "review_token", "observed_at"}) {
		t.Fatal("review state contract is incomplete")
	}
	description := paths[path].(map[string]any)["post"].(map[string]any)["description"].(string)
	for _, boundary := range []string{"Not cluster-wide or durable", "A-B-A", "audit record", "process crash", "unguarded legacy"} {
		if !strings.Contains(description, boundary) {
			t.Fatalf("missing boundary: %s", boundary)
		}
	}
}
