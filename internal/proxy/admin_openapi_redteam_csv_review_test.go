package proxy

import (
	"slices"
	"strings"
	"testing"
)

func TestRedTeamProbeCSVReviewOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, tc := range []struct{ path, method, response string }{{"/admin/redteam/probe-packs/import-review", "post", "RedTeamProbeCSVReview"}, {"/admin/redteam/probe-packs/import", "put", "RedTeamProbeCSVApplied"}} {
		assertJSONOperationSchema(t, paths, tc.path, tc.method, "200", tc.response)
		for _, status := range []string{"400", "401", "403", "409", "413"} {
			assertJSONOperationSchema(t, paths, tc.path, tc.method, status, "AppError")
		}
		op := policyImportSpecObject(t, policyImportSpecObject(t, paths, tc.path), tc.method)
		for _, meaning := range []string{"admin:write AND admin:read", "no seeding", "10000", "32 MiB", "not a secret", "one audit", "Do not automatically replay"} {
			if !strings.Contains(op["description"].(string), meaning) {
				t.Errorf("missing contract meaning %q", meaning)
			}
		}
		p := op["parameters"].([]any)[0].(map[string]any)
		if p["name"] != "If-Match" || p["required"] != (tc.method == "put") {
			t.Fatal("revision precondition not documented")
		}
		body := policyImportSpecObject(t, policyImportSpecObject(t, op, "requestBody"), "content")
		if body["text/csv"] == nil || body["multipart/form-data"] == nil {
			t.Fatal("CSV request formats missing")
		}
	}
	for _, name := range []string{"RedTeamProbePackValue", "RedTeamProbeCaseValue"} {
		properties := policyImportSpecObject(t, policyImportSpecObject(t, schemas, name), "properties")
		for _, hidden := range []string{"parameters", "parameters_json", "created_by", "created_at", "updated_at"} {
			if properties[hidden] != nil {
				t.Fatalf("private field %s exposed", hidden)
			}
		}
	}
	for _, name := range []string{"RedTeamProbePackChange", "RedTeamProbeCaseChange"} {
		schema := policyImportSpecObject(t, schemas, name)
		if !slices.Contains(schema["required"].([]string), "before") || policyImportSpecObject(t, policyImportSpecObject(t, schema, "properties"), "before")["nullable"] != true {
			t.Fatal("new entity before:null must be represented")
		}
	}
	if policyImportSpecObject(t, paths, "/admin/redteam/probe-packs/import")["post"] == nil {
		t.Fatal("legacy import missing")
	}
}
