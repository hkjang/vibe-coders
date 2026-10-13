package proxy

import (
	"encoding/json"
	"testing"
)

func TestAdminKeyEditOpenAPI(t *testing.T) {
	raw, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal("encoding failed")
	}
	var spec map[string]any
	if json.Unmarshal(raw, &spec) != nil {
		t.Fatal("decoding failed")
	}
	paths := spec["paths"].(map[string]any)
	assertJSONRequestSchema(t, paths, "/admin/api-keys/{id}", "patch", "AdminKeyUpdateRequest")
	assertJSONOperationSchema(t, paths, "/admin/api-keys/{id}", "patch", "200", "AdminKeyUpdateResponse")
	for _, code := range []string{"400", "401", "403", "404", "409", "500", "503"} {
		assertJSONOperationSchema(t, paths, "/admin/api-keys/{id}", "patch", code, "AppError")
	}
	schemas := adminKeyEditOpenAPISchemas()
	review := schemas["AdminKeyEditReview"].(map[string]any)
	required := review["required"].([]string)
	if len(required) != 2 || required[0] != "reason" || required[1] != "expected_revision" || review["additionalProperties"] != false {
		t.Fatal("edit review must require reason and revision together")
	}
}
