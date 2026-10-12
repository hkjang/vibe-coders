package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMeKeyRotationOpenAPI(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal("specification encoding failed")
	}
	var spec map[string]any
	if json.Unmarshal(encoded, &spec) != nil {
		t.Fatal("specification decoding failed")
	}
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/me/keys", "get", "200", "MeKeyCatalog")
	const path = "/me/keys/{id}/rotate"
	assertJSONOperationSchema(t, paths, path, "post", "200", "MeKeyRotationResult")
	assertJSONRequestSchema(t, paths, path, "post", "MeKeyRotationRequest")
	for _, status := range []string{"400", "401", "403", "404", "409", "500", "503"} {
		assertJSONOperationSchema(t, paths, path, "post", status, "AppError")
	}
	op := paths[path].(map[string]any)["post"].(map[string]any)
	if op["requestBody"].(map[string]any)["required"] != false {
		t.Fatal("legacy empty-body rotation contract changed")
	}
	for _, fragment := range []string{"original expiry", "86400", "atomically", "lost response", "audit retention", "daily/monthly quota rules", "in-flight reservations", "Individual request history"} {
		if !strings.Contains(op["description"].(string), fragment) {
			t.Fatal("rotation safety description incomplete")
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["MeKeyRotationRequest"].(map[string]any)
	if request["additionalProperties"] != false {
		t.Fatal("rotation request permits unknown fields")
	}
	grace := request["properties"].(map[string]any)["grace_seconds"].(map[string]any)
	if grace["maximum"] != float64(86400) || grace["minimum"] != float64(0) || grace["type"] != "integer" {
		t.Fatal("grace contract bounds changed")
	}
	public := schemas["MeKeyPublic"].(map[string]any)["properties"].(map[string]any)
	if public["key_hash"] != nil || public["secret"] != nil || public["revision"] == nil || public["replaced_by"] == nil || public["grace_ends_at"] == nil {
		t.Fatal("public rotation catalog exposes credentials or omits review metadata")
	}
}
