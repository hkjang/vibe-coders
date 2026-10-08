package proxy

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestRoutingDomainDecisionsOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	const collection = "/admin/routing/domain-decisions"
	assertJSONOperationSchema(t, paths, collection, "get", "200", "RoutingDomainDecisionReport")
	for _, status := range []string{"401", "403", "405", "500"} {
		assertJSONOperationSchema(t, paths, collection, "get", status, "AppError")
	}
	op := paths[collection].(map[string]any)["get"].(map[string]any)
	if op["operationId"] != "get__admin_routing_domain_decisions" || op["requestBody"] != nil ||
		op["responses"].(map[string]any)["400"] != nil || op["responses"].(map[string]any)["404"] != nil {
		t.Fatal("existing GET identity, body or tolerant query behavior changed")
	}
	for name, expected := range map[string]map[string]string{
		"RoutingDomainDecisionReport": {"decisions": "array", "signals": "object"},
		"RoutingDomainDecision": {
			"id": "string", "request_id": "string", "user_id": "string", "team_id": "string", "query_hash": "string", "route": "string",
			"confidence": "number", "tool_names": "array", "evidence_score": "number", "evidence_count": "integer",
			"fallback_used": "boolean", "blocked_by_governance": "boolean", "reason": "string", "created_at": "string",
		},
		"RoutingDomainSignal": {"id": "string", "decision_id": "string", "source": "string", "route": "string", "score": "number", "reason": "string", "created_at": "string"},
	} {
		schema := schemas[name].(map[string]any)
		props := schema["properties"].(map[string]any)
		required := append([]string(nil), schema["required"].([]string)...)
		wantFields := make([]string, 0, len(expected))
		for field, kind := range expected {
			wantFields = append(wantFields, field)
			property := props[field].(map[string]any)
			if property["type"] != kind || property["nullable"] == true || property["enum"] != nil || property["format"] != nil ||
				property["minimum"] != nil || property["maximum"] != nil || property["minLength"] != nil {
				t.Fatal("diagnostic field acquired a wrong type, nullability or unsupported validation constraint")
			}
		}
		sort.Strings(wantFields)
		sort.Strings(required)
		if schema["type"] != "object" || schema["nullable"] == true || schema["additionalProperties"] != false ||
			len(props) != len(expected) || !reflect.DeepEqual(required, wantFields) {
			t.Fatal("required diagnostic object fields differ")
		}
	}
	props := schemas["RoutingDomainDecisionReport"].(map[string]any)["properties"].(map[string]any)
	decisions := props["decisions"].(map[string]any)
	if decisions["items"].(map[string]any)["$ref"] != "#/components/schemas/RoutingDomainDecision" {
		t.Fatal("decisions must be a typed non-null array")
	}
	signals := props["signals"].(map[string]any)
	values := signals["additionalProperties"].(map[string]any)
	if spec["openapi"] != "3.0.3" || values["type"] != "array" || values["nullable"] != true ||
		values["items"].(map[string]any)["$ref"] != "#/components/schemas/RoutingDomainSignal" {
		t.Fatal("signal map values must allow exactly arrays or null under the existing OpenAPI version")
	}
	tools := schemas["RoutingDomainDecision"].(map[string]any)["properties"].(map[string]any)["tool_names"].(map[string]any)
	if tools["items"].(map[string]any)["type"] != "string" || tools["items"].(map[string]any)["nullable"] == true || tools["uniqueItems"] == true {
		t.Fatal("tool names must retain non-null string items and allow duplicates")
	}
	parameters := op["parameters"].([]any)
	if len(parameters) != 4 {
		t.Fatalf("tolerant query parameter count=%d", len(parameters))
	}
	seen := map[string]bool{}
	for _, raw := range parameters {
		p := raw.(map[string]any)
		schema := p["schema"].(map[string]any)
		name := p["name"].(string)
		seen[name] = true
		if p["in"] != "query" || p["required"] != false || schema["type"] != "string" || schema["enum"] != nil || schema["minimum"] != nil || schema["maximum"] != nil {
			t.Fatal("query normalization must not become new request validation")
		}
		if name == "limit" && schema["default"] != "50" || name != "limit" && schema["default"] != nil {
			t.Fatal("only the limit query parameter has a default; omitted window is unrestricted")
		}
	}
	if !reflect.DeepEqual(seen, map[string]bool{"route": true, "request_id": true, "window": true, "limit": true}) {
		t.Fatal("documented query names differ from the actual filters")
	}
	for _, fragment := range []string{
		"routing:read", "raw-prompt", "routing:write is not required", "unmasked", "exact-match", "no time bound", "50", "200",
		"not cursor pagination", "no total, cursor or revision", "no implicit caller-team scope", "non-atomic", "partial array",
		"no signal-completeness flag", "not calibrated probabilities", "false fallback/governance flags", "no automatic promotion",
	} {
		if !strings.Contains(op["description"].(string), fragment) {
			t.Error("decision operation is missing a documented boundary")
		}
	}
}
