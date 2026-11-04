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

func TestAdminKeyEditOpenAPIDistinguishesLegacyExtensions(t *testing.T) {
	schemas := adminKeyEditOpenAPISchemas()
	legacy, ok := schemas["AdminKeyLegacyUpdateRequest"].(map[string]any)
	if !ok || legacy["additionalProperties"] != true || legacy["nullable"] != true {
		t.Fatal("legacy PATCH must accept extension fields and null")
	}
	not, ok := legacy["not"].(map[string]any)
	if !ok || not["type"] != "object" {
		t.Fatal("legacy variant must exclude review presence")
	}
	required, ok := not["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "review" {
		t.Fatal("legacy variant permits review")
	}
	reviewed, ok := schemas["AdminKeyReviewedUpdateRequest"].(map[string]any)
	if !ok || reviewed["additionalProperties"] != false {
		t.Fatal("reviewed variant must reject extension fields")
	}
	required, ok = reviewed["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "review" {
		t.Fatal("reviewed variant must require review")
	}
	request := schemas["AdminKeyUpdateRequest"].(map[string]any)
	variants, ok := request["oneOf"].([]any)
	if !ok || len(variants) != 2 {
		t.Fatal("PATCH must separate legacy and reviewed contracts")
	}
}
