package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRequestNoteOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	path := "/admin/requests/{id}/note"
	for _, method := range []string{"get", "post", "put", "delete"} {
		response := "RequestNoteResponse"
		if method == "delete" {
			response = "RequestNoteDeletedResponse"
		}
		assertJSONOperationSchema(t, paths, path, method, "200", response)
		for _, status := range []string{"400", "401", "403", "404", "405", "500"} {
			assertJSONOperationSchema(t, paths, path, method, status, "AppError")
		}
	}
	for _, method := range []string{"post", "put"} {
		assertJSONRequestSchema(t, paths, path, method, "RequestNoteWriteRequest")
		description := paths[path].(map[string]any)[method].(map[string]any)["description"].(string)
		for _, fragment := range []string{"null", "preserve_fields", "current database", "committed row", "revision/CAS", "legacy replacement", "best-effort"} {
			if !strings.Contains(description, fragment) {
				t.Errorf("write description lost %q", fragment)
			}
		}
	}
	assertJSONOperationSchema(t, paths, path, "patch", "200", "RequestNoteAppResponse")
	assertJSONRequestSchema(t, paths, path, "patch", "RequestNotePatchRequest")
	patchOperation := paths[path].(map[string]any)["patch"].(map[string]any)
	for _, fragment := range []string{"explicit preserve_fields", "405", "Never automatically fall back"} {
		if !strings.Contains(patchOperation["description"].(string), fragment) {
			t.Fatalf("PATCH lost mixed-version safety boundary %q", fragment)
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	app := schemas["RequestNoteAppResponse"].(map[string]any)
	if !reflect.DeepEqual(app["required"], []any{"request_id", "tags", "note", "created_by", "updated_at", "exists", "redacted_fields"}) {
		t.Fatal("app response lost its flat required metadata")
	}
	request := schemas["RequestNoteWriteRequest"].(map[string]any)
	patchRequest := schemas["RequestNotePatchRequest"].(map[string]any)
	if !reflect.DeepEqual(patchRequest["required"], []any{"preserve_fields"}) || patchRequest["nullable"] == true {
		t.Fatal("PATCH must require a non-null body with explicit preserve_fields")
	}
	if _, required := request["required"]; required || request["nullable"] != true {
		t.Fatal("optional fields and null-body legacy replacement must remain documented")
	}
	requestFields := request["properties"].(map[string]any)
	for _, name := range []string{"note", "tags"} {
		if requestFields[name].(map[string]any)["nullable"] != true {
			t.Fatal("unpreserved replacement must still accept explicit null")
		}
	}
	for _, field := range []map[string]any{
		requestFields["preserve_fields"].(map[string]any),
		app["properties"].(map[string]any)["redacted_fields"].(map[string]any),
	} {
		if field["type"] != "array" || field["nullable"] == true || field["uniqueItems"] != true || !reflect.DeepEqual(field["items"].(map[string]any)["enum"], []any{"note", "tags"}) {
			t.Fatal("field intents must be non-null arrays of unique known fields")
		}
	}
	for _, name := range []string{"RequestNoteAppResponse", "RequestNoteLegacyResponse"} {
		if schemas[name].(map[string]any)["additionalProperties"] != false {
			t.Fatal("header-dependent response union must not match both alternatives")
		}
	}
}
