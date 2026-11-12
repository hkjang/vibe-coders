package proxy

import "testing"

func TestPersonalAccessOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, tc := range []struct{ path, method, schema string }{
		{"/me/sessions", "get", "MeAccessSessions"},
		{"/me/sessions/{id}", "delete", "MeAccessSessionRevoked"},
		{"/me/sessions/revoke-others", "post", "MeAccessSessionsRevoked"},
		{"/me/onboarding-pack", "get", "MeAccessOnboarding"},
		{"/me/connection-doctor", "post", "MeAccessDoctor"},
	} {
		assertJSONOperationSchema(t, paths, tc.path, tc.method, "200", tc.schema)
		op := paths[tc.path].(map[string]any)[tc.method].(map[string]any)
		response := op["responses"].(map[string]any)["200"].(map[string]any)
		if schemas[tc.schema] == nil || response["headers"].(map[string]any)["Cache-Control"] == nil {
			t.Fatal("missing personal access schema/cache contract")
		}
		if tc.path == "/me/connection-doctor" {
			if len(op["security"].([]any)) != 0 || op["requestBody"].(map[string]any)["required"] != false {
				t.Fatal("anonymous/optional doctor input contract changed")
			}
		} else if op["requestBody"] != nil {
			t.Fatal("personal session operation must not invent a required body")
		}
	}
}
