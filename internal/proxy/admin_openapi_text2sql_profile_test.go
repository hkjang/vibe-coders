package proxy

import (
	"encoding/json"
	"testing"
)

func TestText2SQLProfileConnectionOpenAPI(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	assertJSONRequestSchema(t, paths, "/admin/text2sql/profiles", "post", "Text2SQLProfileInput")
	assertJSONOperationSchema(t, paths, "/admin/text2sql/profiles", "post", "201", "Text2SQLProfileSaved")
	assertJSONRequestSchema(t, paths, "/admin/text2sql/profiles", "put", "Text2SQLProfileReviewedInput")
	assertJSONOperationSchema(t, paths, "/admin/text2sql/profiles", "put", "200", "Text2SQLProfileSaved")
	assertJSONRequestSchema(t, paths, text2SQLProfileDeleteReviewPath, "post", "Text2SQLProfileReviewedDeleteInput")
	assertJSONOperationSchema(t, paths, text2SQLProfileDeleteReviewPath, "post", "200", "Text2SQLProfileReviewedDeleted")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"Text2SQLProfile", "Text2SQLProfileInput"} {
		properties := schemas[name].(map[string]any)["properties"].(map[string]any)
		if properties["exec_connection_id"].(map[string]any)["type"] != "string" {
			t.Fatal("generated clients must carry the execution connection identifier")
		}
		for _, private := range []string{"dsn", "encrypted_dsn", "password"} {
			if _, exists := properties[private]; exists {
				t.Fatal("profile contracts must not include connection credentials")
			}
		}
	}
}
