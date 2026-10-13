package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminKeyRevokeOpenAPI(t *testing.T) {
	raw, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal("encoding failed")
	}
	var spec map[string]any
	if json.Unmarshal(raw, &spec) != nil {
		t.Fatal("decoding failed")
	}
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/api-keys", "get", "200", "AdminKeyCatalog")
	assertJSONRequestSchema(t, paths, "/admin/api-keys/{id}", "delete", "AdminKeyRevokeRequest")
	operation := paths["/admin/api-keys/{id}"].(map[string]any)["delete"].(map[string]any)
	if operation["requestBody"].(map[string]any)["required"] != false {
		t.Fatal("legacy empty body must remain supported")
	}
	for _, code := range []string{"400", "401", "403", "404", "409", "500", "503"} {
		assertJSONOperationSchema(t, paths, "/admin/api-keys/{id}", "delete", code, "AppError")
	}
}

func TestAdminKeyRevokeRequestValidation(t *testing.T) {
	for _, body := range []string{`[]`, `{"reason":"x"}`, `{"expected_revision":"` + strings.Repeat("a", 64) + `"}`, `{"reason":"x","reason":"y"}`, `{"reason":null}`, `{"reason":" "}`, `{"reason":1}`, `{"grace_seconds":0}`, `{"extra":true}`, `{} {}`, `null {}`, `{"reason":"` + strings.Repeat("가", 1025) + `"}`, strings.Repeat(" ", 8193)} {
		r := httptest.NewRequest("DELETE", "/", strings.NewReader(body))
		if _, err := readKeyReviewRequest(httptest.NewRecorder(), r, false); err == nil {
			t.Fatal("invalid review accepted")
		}
	}
	for _, body := range []string{"", `{}`, `null`, `{"reason":" 확인 ","expected_revision":"` + strings.Repeat("a", 64) + `"}`} {
		r := httptest.NewRequest("DELETE", "/", strings.NewReader(body))
		if _, err := readKeyReviewRequest(httptest.NewRecorder(), r, false); err != nil {
			t.Fatal("compatible review rejected")
		}
	}
}

func TestAdminKeyRevokeOpenAPIReviewAlternatives(t *testing.T) {
	schema := adminKeyRevokeOpenAPISchemas()["AdminKeyRevokeRequest"].(map[string]any)
	variants, ok := schema["oneOf"].([]any)
	if !ok || len(variants) != 2 {
		t.Fatal("revoke body must distinguish empty legacy input from paired review")
	}
	legacy := variants[0].(map[string]any)
	if legacy["type"] != "object" || legacy["nullable"] != true || legacy["additionalProperties"] != false || legacy["maxProperties"] != 0 {
		t.Fatal("legacy alternative must accept only empty object or null")
	}
	review := variants[1].(map[string]any)
	required, ok := review["required"].([]string)
	if !ok || len(required) != 2 || required[0] != "reason" || required[1] != "expected_revision" || review["additionalProperties"] != false {
		t.Fatal("review alternative must require both fields and reject extras")
	}
}

func TestAdminKeyRevokeOpenAPIHardParameter(t *testing.T) {
	op := map[string]any{"parameters": []any{map[string]any{"name": "id", "in": "path", "required": true}}}
	enrichAdminKeyRevokeOpenAPI("delete", op, map[string]any{})
	parameters := op["parameters"].([]any)
	if len(parameters) != 2 || parameters[0].(map[string]any)["name"] != "id" {
		t.Fatal("hard query parameter must be added without losing the path parameter")
	}
	hard := parameters[1].(map[string]any)
	if hard["name"] != "hard" || hard["in"] != "query" || hard["required"] != false {
		t.Fatal("missing optional hard query parameter")
	}
	values := hard["schema"].(map[string]any)["enum"].([]int)
	if len(values) != 2 || values[0] != 0 || values[1] != 1 {
		t.Fatal("hard query parameter must offer explicit revoke/delete values")
	}
}
