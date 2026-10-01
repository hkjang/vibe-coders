package proxy

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestProviderConnectionTestOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	op := spec["paths"].(map[string]any)[connectionTestPath].(map[string]any)["post"].(map[string]any)
	if op["operationId"] != openAPIOperationID("post", connectionTestPath) {
		t.Fatal("missing generated connection operation")
	}
	requestBody := op["requestBody"].(map[string]any)
	if requestBody["required"] != true || requestBody["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)["$ref"] != "#/components/schemas/ProviderConnectionTestRequest" {
		t.Fatal("request is not bound to the typed connection input")
	}
	responses := op["responses"].(map[string]any)
	if responses["200"].(map[string]any)["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)["$ref"] != "#/components/schemas/ProviderConnectionTestResponse" {
		t.Fatal("successful operation does not use the fixed result schema")
	}
	for _, code := range []string{"400", "401", "403", "404", "405", "409", "503"} {
		if responses[code] == nil {
			t.Fatalf("undocumented connection error: %s", code)
		}
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["ProviderConnectionTestRequest"].(map[string]any)
	properties := request["properties"].(map[string]any)
	if request["additionalProperties"] != false || len(request["oneOf"].([]any)) != 2 || len(properties) != 6 {
		t.Fatal("credential input must reject extras and distinguish name/reference")
	}
	if !reflect.DeepEqual(properties["credential_mode"].(map[string]any)["enum"], []string{"draft", "stored", "none"}) || properties["api_key"].(map[string]any)["writeOnly"] != true {
		t.Fatal("credential modes or write-only secret contract drifted")
	}
	for _, field := range []string{"api_key", "base_url"} {
		if properties[field].(map[string]any)["maxLength"] != 8192 {
			t.Fatalf("unbounded probe input: %s", field)
		}
	}
	if properties["timeout_ms"].(map[string]any)["minimum"] != 0 || properties["timeout_ms"].(map[string]any)["maximum"] != 600000 {
		t.Fatal("input timeout no longer matches existing provider form range")
	}
	response := schemas["ProviderConnectionTestResponse"].(map[string]any)
	fields := response["properties"].(map[string]any)
	encoded, err := json.Marshal(providerConnectionResult{})
	if err != nil {
		t.Fatal(err)
	}
	var runtimeFields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &runtimeFields); err != nil || len(fields) != 5 || len(runtimeFields) != 5 || len(response["required"].([]string)) != 5 || response["additionalProperties"] != false {
		t.Fatal("fixed result field boundary drifted")
	}
	for key := range runtimeFields {
		if _, found := fields[key]; !found {
			t.Fatalf("undocumented result field: %s", key)
		}
	}
	if !reflect.DeepEqual(fields["outcome"].(map[string]any)["enum"], []string{"catalog_available", "authentication_rejected", "redirect_blocked", "upstream_rejected", "invalid_response", "response_too_large", "model_limit_exceeded", "timeout", "connection_failed", "cancelled"}) {
		t.Fatal("safe outcome enum drifted")
	}
	for _, field := range []string{"upstream_status", "model_count"} {
		if fields[field].(map[string]any)["nullable"] != true {
			t.Fatalf("unknown result cannot be represented: %s", field)
		}
	}
	if fields["model_count"].(map[string]any)["maximum"] != maxModelsPerProvider || fields["timeout_ms"].(map[string]any)["maximum"] != 10000 || fields["upstream_status"].(map[string]any)["maximum"] != 599 {
		t.Fatal("result bounds drifted")
	}
}
