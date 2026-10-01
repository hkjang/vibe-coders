package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestPolicyImportOpenAPIInput(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONRequestSchema(t, paths, "/admin/policies/import", "post", "PolicyImportRequest")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := policyImportSpecObject(t, schemas, "PolicyImportRequest")
	if request["additionalProperties"] != true || request["x-body-max-bytes"] != policyImportMaxBody || request["x-json-max-depth"] != policyImportMaxDepth || request["x-total-rules-limit"] != 10000 {
		t.Fatal("typed compatibility or bounded JSON contract missing")
	}
	policies := policyImportSpecObject(t, policyImportSpecObject(t, request, "properties"), "policies")
	if policies["minItems"] != 1 || policies["maxItems"] != 1000 || policies["nullable"] == true {
		t.Fatal("policy array must be nonempty, non-null and bounded")
	}
	policy := policyImportSpecObject(t, schemas, "PolicyImportPolicy")
	rule := policyImportSpecObject(t, schemas, "PolicyImportRule")
	if !reflect.DeepEqual(policy["required"], []string{"id", "name"}) || !reflect.DeepEqual(rule["required"], []string{"id"}) || policy["additionalProperties"] != true || rule["additionalProperties"] != true {
		t.Fatal("typed known fields/ignored extras must not become a new strict decoder")
	}
	p := policyImportSpecObject(t, policy, "properties")
	r := policyImportSpecObject(t, rule, "properties")
	for _, name := range []string{"description", "enabled", "priority", "rollout_percent", "created_at", "updated_at", "rules"} {
		if policyImportSpecObject(t, p, name)["nullable"] != true {
			t.Fatalf("legacy nullable policy field missing: %s", name)
		}
	}
	for _, name := range []string{"policy_id", "name", "enabled", "priority", "conditions", "actions", "rollout_percent", "created_at", "updated_at"} {
		if policyImportSpecObject(t, r, name)["nullable"] != true {
			t.Fatalf("legacy nullable rule field missing: %s", name)
		}
	}
	for _, field := range []map[string]any{policyImportSpecObject(t, p, "priority"), policyImportSpecObject(t, p, "rollout_percent"), policyImportSpecObject(t, r, "priority")} {
		if field["minimum"] != nil || field["maximum"] != nil {
			t.Fatal("normalization must not be documented as an input range rejection")
		}
	}
	for _, name := range []string{"conditions", "actions"} {
		if policyImportSpecObject(t, r, name)["additionalProperties"] != true {
			t.Fatal("opaque rule JSON must retain unknown nested fields")
		}
	}
}

func TestPolicyImportOpenAPIResponses(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/policies/import", "post", "200", "PolicyImportResponse")
	assertJSONOperationSchema(t, paths, "/admin/policies/export", "get", "200", "PolicyExportResponse")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	policy := policyImportSpecObject(t, schemas, "PolicyExportPolicy")
	if !slices.Contains(policy["required"].([]string), "rules") {
		t.Fatal("export must always emit rules including the empty array")
	}
	rules := policyImportSpecObject(t, policyImportSpecObject(t, policy, "properties"), "rules")
	if rules["type"] != "array" || rules["nullable"] == true || rules["maxItems"] != nil {
		t.Fatal("export array cannot inherit import's null preservation or input cap")
	}
	result := policyImportSpecObject(t, schemas, "PolicyImportResponse")
	if !reflect.DeepEqual(result["required"], []string{"dry_run", "created", "updated", "plan"}) {
		t.Fatal("existing import result shape must be typed without new fields")
	}
	plan := policyImportSpecObject(t, schemas, "PolicyImportPlanItem")
	fields := policyImportSpecObject(t, plan, "properties")
	if !reflect.DeepEqual(policyImportSpecObject(t, fields, "action")["enum"], []string{"create", "update"}) || !strings.Contains(policyImportSpecObject(t, fields, "rules")["description"].(string), "not the preserved rule count") {
		t.Fatal("plan must describe submitted rule count, not inferred preserved rules")
	}
}

func TestPolicyImportOpenAPIErrorsAndMeaning(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	for _, status := range []string{"400", "401", "405", "413", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/policies/import", "post", status, "AppError")
	}
	for _, status := range []string{"401", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/policies/export", "get", status, "AppError")
	}
	importOp := policyImportSpecObject(t, policyImportSpecObject(t, paths, "/admin/policies/import"), "post")
	exportOp := policyImportSpecObject(t, policyImportSpecObject(t, paths, "/admin/policies/export"), "get")
	if policyImportSpecObject(t, exportOp, "responses")["405"] != nil {
		t.Fatal("export has no handler method guard; do not invent a 405 response")
	}
	importDescription, importOK := importOp["description"].(string)
	exportDescription, exportOK := exportOp["description"].(string)
	if !importOK || !exportOK {
		t.Fatal("import/export operation descriptions are missing")
	}
	for _, fragment := range []string{"admin:write", "no server CAS", "best-effort", "nil/null", "rule IDs", "other processes", "case-insensitive"} {
		if !strings.Contains(importDescription, fragment) {
			t.Fatalf("import meaning missing %q", fragment)
		}
	}
	for _, fragment := range []string{"security:read", "statement snapshot", "raw", "not byte-exact"} {
		if !strings.Contains(exportDescription, fragment) {
			t.Fatalf("export meaning missing %q", fragment)
		}
	}
	parameters := importOp["parameters"].([]any)
	query := parameters[0].(map[string]any)
	if query["name"] != "dry_run" || policyImportSpecObject(t, query, "schema")["type"] != "string" || !strings.Contains(query["description"].(string), `exactly "1"`) {
		t.Fatal("dry_run is the exact string 1, not boolean coercion")
	}
	error400 := policyImportSpecObject(t, policyImportSpecObject(t, importOp, "responses"), "400")["description"].(string)
	for _, code := range []string{"invalid_body", "empty_payload", "policy_import_limit", "invalid_policy", "invalid_policy_rule", "duplicate_policy_id", "duplicate_rule_id", "policy_rule_conflict"} {
		if !strings.Contains(error400, code) {
			t.Fatalf("missing fixed import validation code %s", code)
		}
	}
}

func TestPolicyImportOpenAPIRuntimeWire(t *testing.T) {
	f := newPolicyImportContractFixture(t)
	status, data := f.request(t, http.MethodGet, "/openapi.json", nil)
	if status != 200 {
		t.Fatalf("actual OpenAPI status=%d", status)
	}
	var spec map[string]any
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	paths := policyImportSpecObject(t, spec, "paths")
	assertJSONOperationSchema(t, paths, "/admin/policies/export", "get", "200", "PolicyExportResponse")
	status, data = f.request(t, http.MethodGet, "/admin/policies/export", nil)
	if status != 200 {
		t.Fatalf("actual export status=%d", status)
	}
	var exported struct {
		Version  int                          `json:"version"`
		Count    int                          `json:"count"`
		Policies []map[string]json.RawMessage `json:"policies"`
	}
	if err := json.Unmarshal(data, &exported); err != nil || exported.Version != 1 || exported.Count != len(exported.Policies) {
		t.Fatal("actual export envelope differs from documented version/count")
	}
	for _, p := range exported.Policies {
		if len(p) != 9 || len(p["rules"]) == 0 || string(p["rules"]) == "null" {
			t.Fatal("actual policy export requires nine fields including non-null rules")
		}
	}
}

func policyImportSpecObject(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key].(map[string]any)
	if !ok {
		t.Fatalf("missing OpenAPI object %s", key)
	}
	return value
}
