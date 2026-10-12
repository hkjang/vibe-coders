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
	for _, boundary := range []string{"without restoring", "TrimSpace", "malformed", "commit atomically", "not a client-supplied revision check", "cannot be deleted until recovery finishes"} {
		if !strings.Contains(description, boundary) {
			t.Fatalf("missing boundary %s", boundary)
		}
	}
	responses := op["responses"].(map[string]any)
	if !strings.Contains(responses["409"].(map[string]any)["description"].(string), "change_set_conflict") {
		t.Fatal("concurrent deletion conflict missing from contract")
	}
	if _, body := path["get"].(map[string]any)["requestBody"]; body {
		t.Fatal("GET contract must not acquire a body")
	}
}

func TestChangeSetRecoveryOpenAPI(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	for _, action := range []string{"submit", "approve", "apply", "rollback"} {
		op := paths["/admin/change-sets/{id}/"+action].(map[string]any)["post"].(map[string]any)
		body, ok := op["requestBody"].(map[string]any)
		if !ok || body["required"] != false {
			t.Fatalf("%s must declare an optional legacy-compatible reason body", action)
		}
		schema := body["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)
		note := schema["properties"].(map[string]any)["note"].(map[string]any)
		if schema["type"] != "object" || schema["nullable"] != true || note["type"] != "string" || note["nullable"] != true {
			t.Errorf("%s reason must support nullable body and note", action)
		}
		if _, required := schema["required"]; required {
			t.Errorf("%s must not require a legacy note", action)
		}
	}
	for _, action := range []string{"apply", "rollback"} {
		op := paths["/admin/change-sets/{id}/"+action].(map[string]any)["post"].(map[string]any)
		description := op["description"].(string)
		for _, boundary := range []string{"one transaction", "outside SQL", "one completion audit", "never rewrite", "Older pending rows", "multi-pod"} {
			if !strings.Contains(description, boundary) {
				t.Errorf("%s contract omitted %s", action, boundary)
			}
		}
		responses := op["responses"].(map[string]any)
		if !strings.Contains(responses["503"].(map[string]any)["description"].(string), "change_set_finalize_pending") {
			t.Error("finalization recovery error missing")
		}
	}
}
