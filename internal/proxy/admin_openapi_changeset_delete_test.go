package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChangeSetDeleteOpenAPIReason(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	path := spec["paths"].(map[string]any)["/admin/change-sets/{id}"].(map[string]any)
	op := path["delete"].(map[string]any)
	body := op["requestBody"].(map[string]any)
	if body["required"] != false {
		t.Fatal("legacy requests without a body must remain supported")
	}
	schema := body["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)
	if schema["type"] != "object" || schema["nullable"] != true {
		t.Fatal("wrong optional body contract")
	}
	note := schema["properties"].(map[string]any)["note"].(map[string]any)
	if note["type"] != "string" || note["nullable"] != true {
		t.Fatal("reason missing from the request contract")
	}
	if _, required := schema["required"]; required {
		t.Fatal("legacy notes are optional")
	}
	description := op["description"].(string)
	for _, boundary := range []string{"without restoring", "TrimSpace", "malformed", "not an atomic guarantee"} {
		if !strings.Contains(description, boundary) {
			t.Fatalf("missing boundary %s", boundary)
		}
	}
	if _, body := path["get"].(map[string]any)["requestBody"]; body {
		t.Fatal("GET contract must not acquire a body")
	}
}
