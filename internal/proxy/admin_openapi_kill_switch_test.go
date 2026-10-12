package proxy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestKillSwitchTrafficOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/kill-switch", "get", "200", "KillSwitchState")
	assertJSONOperationSchema(t, paths, "/admin/kill-switch", "get", "503", "AppError")
	assertJSONOperationSchema(t, paths, "/admin/kill-switch", "post", "200", "KillSwitchState")
	assertJSONOperationSchema(t, paths, "/admin/kill-switch", "post", "500", "AppError")
	assertJSONRequestSchema(t, paths, "/admin/kill-switch", "post", "KillSwitchChangeRequest")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	request := schemas["KillSwitchChangeRequest"].(map[string]any)
	if _, required := request["required"]; required || request["nullable"] != true {
		t.Fatal("legacy null/omitted field behavior changed")
	}
	for method, fragments := range map[string][]string{
		"get":  {"Uncached", "return503", "not an atomic cluster", "Inference cache"},
		"post": {"atomically", "without a follow-up read", "uncertain", "Legacy omission/null", "No optimistic concurrency"},
	} {
		desc := paths["/admin/kill-switch"].(map[string]any)[method].(map[string]any)["description"].(string)
		for _, fragment := range fragments {
			if !strings.Contains(desc, fragment) {
				t.Fatalf("%s boundary absent: %s", method, fragment)
			}
		}
	}
	state := schemas["KillSwitchState"].(map[string]any)
	if !reflect.DeepEqual(state["required"], []any{"disabled"}) {
		t.Fatal("older servers without traffic must remain compatible")
	}
	observation := schemas["KillSwitchTrafficObservation"].(map[string]any)
	if !reflect.DeepEqual(observation["required"], []any{"scope", "instance_ref", "observed_at", "proxy_inflight"}) {
		t.Fatal("observation metadata must be complete")
	}
	props := observation["properties"].(map[string]any)
	if !reflect.DeepEqual(props["scope"].(map[string]any)["enum"], []any{"responding_process"}) {
		t.Fatal("cluster-wide claims must not be accepted")
	}
	if props["proxy_inflight"].(map[string]any)["minimum"] != float64(0) || props["proxy_inflight"].(map[string]any)["type"] != "integer" {
		t.Fatal("count must be a nonnegative integer")
	}
	if props["instance_ref"].(map[string]any)["pattern"] != "^process_[a-f0-9]{16}$" || props["observed_at"].(map[string]any)["format"] != "date-time" {
		t.Fatal("reference and timestamp contract changed")
	}
	description := observation["description"].(string)
	for _, required := range []string{"not zero", "not cluster-wide", "separately registered", "MCP"} {
		if !strings.Contains(description, required) {
			t.Fatalf("missing scope boundary %q", required)
		}
	}
}
