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
