package proxy

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestRoutingDomainReviewOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	const collection = "/admin/routing/domain-review"
	for _, tc := range []struct {
		path, method, schema string
		errors               []string
	}{
		{collection, "get", "RoutingDomainReviewReport", []string{"401", "403", "405", "500"}},
		{collection + "/{id}", "post", "RoutingDomainReviewAck", []string{"400", "401", "405", "500"}},
	} {
		assertJSONOperationSchema(t, paths, tc.path, tc.method, "200", tc.schema)
		for _, status := range tc.errors {
			assertJSONOperationSchema(t, paths, tc.path, tc.method, status, "AppError")
		}
		op := paths[tc.path].(map[string]any)[tc.method].(map[string]any)
		if op["operationId"] != openAPIOperationID(tc.method, tc.path) || op["requestBody"] != nil || op["responses"].(map[string]any)["404"] != nil {
			t.Fatal("existing operation identity, unused body or absent-ID behavior changed")
		}
	}
	for name, expected := range map[string][]string{
		"RoutingDomainReviewReport": {"items"},
		"RoutingDomainReviewItem":   {"id", "decision_id", "query_text", "suggested_route", "current_route", "reason", "status", "created_at", "reviewed_at"},
		"RoutingDomainReviewAck":    {"id", "status"},
	} {
		schema := schemas[name].(map[string]any)
		props := schema["properties"].(map[string]any)
		required := append([]string(nil), schema["required"].([]string)...)
		sort.Strings(expected)
		sort.Strings(required)
		if schema["nullable"] == true || len(props) != len(expected) || !reflect.DeepEqual(required, expected) {
			t.Fatal("required non-null schema field contract differs")
		}
		for _, field := range expected {
			property := props[field].(map[string]any)
			if property["nullable"] == true || (field != "items" && property["type"] != "string") {
				t.Fatal("review fields must be required non-null strings")
			}
		}
	}
	props := schemas["RoutingDomainReviewItem"].(map[string]any)["properties"].(map[string]any)
	if props["status"].(map[string]any)["enum"] != nil || props["reviewed_at"].(map[string]any)["format"] != nil || props["created_at"].(map[string]any)["format"] != nil {
		t.Fatal("stored status and timestamp strings must not acquire closed values or date validation")
	}
	ack := schemas["RoutingDomainReviewAck"].(map[string]any)["properties"].(map[string]any)
	if !reflect.DeepEqual(ack["status"].(map[string]any)["enum"], []string{"approved", "rejected"}) {
		t.Fatal("action acknowledgment has exactly two statuses")
	}
	items := schemas["RoutingDomainReviewReport"].(map[string]any)["properties"].(map[string]any)["items"].(map[string]any)
	if items["type"] != "array" || items["items"].(map[string]any)["$ref"] != "#/components/schemas/RoutingDomainReviewItem" {
		t.Fatal("queue must be a typed non-null item array")
	}
	get := paths[collection].(map[string]any)["get"].(map[string]any)
	parameters := get["parameters"].([]any)
	if len(parameters) != 3 || get["responses"].(map[string]any)["400"] != nil {
		t.Fatal("GET supports three tolerant query parameters without a validation 400")
	}
	seen := map[string]bool{}
	for _, raw := range parameters {
		p := raw.(map[string]any)
		schema := p["schema"].(map[string]any)
		seen[p["name"].(string)] = true
		if p["in"] != "query" || p["required"] != false || schema["type"] != "string" || schema["enum"] != nil || schema["minimum"] != nil || schema["maximum"] != nil {
			t.Fatal("query normalization must not become new validation")
		}
	}
	if !seen["status"] || !seen["window"] || !seen["limit"] {
		t.Fatal("GET query names differ")
	}
	post := paths[collection+"/{id}"].(map[string]any)["post"].(map[string]any)
	postParameters := post["parameters"].([]any)
	if len(postParameters) != 1 || postParameters[0].(map[string]any)["name"] != "id" || paths[collection+"/{id}/{action}"] != nil {
		t.Fatal("the established POST route must keep action inside the existing ID parameter")
	}
	for _, tc := range []struct {
		op        map[string]any
		fragments []string
	}{
		{get, []string{"routing:read", "raw-prompt", "unmasked query_text", "pending", "no time bound", "50", "200", "created_at", "not cursor pagination", "route, request_id, team and team_id"}},
		{post, []string{"routing:write", "no raw-prompt role check", "decoded", "body is unused", "only status and reviewed_at", "best-effort", "no pending-state", "existence", "revision/CAS", "idempotency", "nonexistent IDs also return 200", "does not create or approve domain examples"}},
	} {
		for _, fragment := range tc.fragments {
			if !strings.Contains(tc.op["description"].(string), fragment) {
				t.Error("review operation is missing a documented behavior boundary")
			}
		}
	}
}
